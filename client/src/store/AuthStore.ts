import { fromBase64Url, toBase64Url } from "@mesh-chat/common";
import { PasswordHasher } from "../crypto/PasswordHasher.js";
import { ClientCrypto } from "../crypto/ClientCrypto.js";
import { KeyManager } from "../crypto/KeyManager.js";

/**
 * The data held in memory once a user is logged in.
 *
 * Private keys live inside `clientCrypto` as non-extractable CryptoKey
 * objects — they can be used to sign and decrypt but cannot be read back
 * out of memory as bytes.
 */
export interface Session {
  userId: string;
  username: string;
  serverUrl: string;    // base URL of the server this session belongs to
  enc_pubkey: string;   // base64url SPKI — our encryption public key
  sig_pubkey: string;   // base64url SPKI — our signing public key
  clientCrypto: ClientCrypto;  // holds both private keys in memory
}

/**
 * Manages user authentication state and orchestrates the full
 * registration and login flows.
 *
 * Registration flow:
 *   1. PasswordHasher.hash(username, password) → clientHash
 *   2. ClientCrypto.generateKeyPairs() → 2 RSA-4096 keypairs
 *   3. Export public keys (SPKI → base64url) for server storage
 *   4. Export private keys (PKCS8 DER) → KeyManager.encrypt (×2)
 *   5. POST /auth/register with all of the above
 *   6. Save userId + call login() to get a fully authenticated session
 *
 * Login flow (two HTTP round trips):
 *   Round 1 — password verification:
 *     1. PasswordHasher.hash(username, password) → clientHash
 *     2. POST /auth/login → { userId, nonce, enc_privkey_store, sig_privkey_store }
 *   Round 2 — cryptographic proof:
 *     3. KeyManager.decrypt(enc_privkey_store, password) → encPrivKeyBytes
 *     4. KeyManager.decrypt(sig_privkey_store, password) → sigPrivKeyBytes
 *     5. ClientCrypto.importPrivateKeys(encPrivKeyBytes, sigPrivKeyBytes, ...)
 *     6. ClientCrypto.signBytes(fromBase64Url(nonce)) → signedNonce
 *     7. POST /auth/login/verify → { userId, username, enc_pubkey, sig_pubkey }
 *
 * Why the two-step login?
 *   The server can't just accept "I know the password" because that's
 *   easily spoofed. The nonce challenge forces the client to prove it
 *   can actually use the private key — which requires knowing the
 *   plaintext password to decrypt the encrypted blob.
 *
 * OOP Pattern: Store — holds session state and exposes async methods
 * for state transitions (register, login, logout). Phase 9 will wrap
 * this in a React context so components can observe the state.
 */
export class AuthStore {
  private session: Session | null = null;

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a new user account on the given server.
   *
   * On success, the returned userId can be used immediately to call login().
   *
   * @param serverUrl - Base URL of the server, e.g. "http://127.0.0.1:3000"
   * @param username  - Display name chosen by the user
   * @param password  - Plaintext password (never sent to the server)
   * @returns The newly created userId
   * @throws If the username is taken or any crypto/network step fails
   */
  async register(serverUrl: string, username: string, password: string): Promise<string> {
    // Step 1: Hash the password with the username so the server never sees
    // the plaintext. The server will apply Argon2id on top.
    const clientHash = await PasswordHasher.hash(username, password);

    // Step 2: Generate both RSA-4096 key pairs.
    // This is the slow step — 1-3s in a browser.
    const crypto = new ClientCrypto();
    await crypto.generateKeyPairs();

    // Step 3: Export public keys for server-side storage.
    const pubKeys = await crypto.exportPublicKeys();

    // Step 4: Export and encrypt both private keys.
    // KeyManager produces blobs: salt(16) | iv(12) | ciphertext — ready
    // for server storage. The password is used to derive the AES key.
    const privKeys = await crypto.exportPrivateKeys();
    const enc_privkey_store = await KeyManager.encryptPrivateKey(privKeys.encPrivKey, password);
    const sig_privkey_store = await KeyManager.encryptPrivateKey(privKeys.sigPrivKey, password);

    // Step 5: Send everything to the server.
    const res = await fetch(`${serverUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        clientHash,
        enc_pubkey: pubKeys.enc_pubkey,
        sig_pubkey: pubKeys.sig_pubkey,
        enc_privkey_store,
        sig_privkey_store,
      }),
    });

    if (!res.ok) {
      const body = await res.json() as { error?: string };
      throw new Error(body.error ?? `Registration failed (${res.status})`);
    }

    const { userId } = await res.json() as { userId: string };
    return userId;
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  /**
   * Authenticate an existing user and establish a session.
   *
   * On success, the session is stored internally and can be retrieved
   * with getSession(). The private keys are held in memory as
   * non-extractable CryptoKeys — gone when the tab closes.
   *
   * @param serverUrl - Base URL of the server
   * @param username  - The user's display name
   * @param password  - The user's plaintext password
   * @returns The established Session
   * @throws On invalid credentials, wrong password (GCM auth failure),
   *         or bad nonce signature
   */
  async login(serverUrl: string, username: string, password: string): Promise<Session> {
    // ── Round 1: password verification ───────────────────────────────────

    const clientHash = await PasswordHasher.hash(username, password);

    const loginRes = await fetch(`${serverUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, clientHash }),
    });

    if (!loginRes.ok) {
      const body = await loginRes.json() as { error?: string };
      throw new Error(body.error ?? `Login failed (${loginRes.status})`);
    }

    const {
      userId,
      nonce,
      enc_privkey_store,
      sig_privkey_store,
    } = await loginRes.json() as {
      userId: string;
      nonce: string;
      enc_privkey_store: string;
      sig_privkey_store: string;
    };

    // ── Round 2: cryptographic proof ──────────────────────────────────────

    // Decrypt the private key blobs using Argon2id + AES-256-GCM.
    // If the password is wrong, AES-GCM's auth tag will fail here.
    const encPrivKeyBytes = await KeyManager.decryptPrivateKey(enc_privkey_store, password);
    const sigPrivKeyBytes = await KeyManager.decryptPrivateKey(sig_privkey_store, password);

    // Import the decrypted keys as non-extractable CryptoKeys.
    // We need the server's stored public keys for the import — fetch
    // them in the verify response below, so for now we construct a
    // temporary ClientCrypto to get them after verify.
    //
    // To avoid a third round trip, we sign the nonce first, then
    // the verify response returns the public keys we need.
    const tempCrypto = new ClientCrypto();

    // We need *some* public key to import alongside the private key.
    // We use a placeholder approach: import, sign, then re-import
    // after verify gives us the real public keys.
    //
    // Actually: we sign the nonce bytes using a temporary wrapper that
    // imports the signing private key with the minimal key usage.
    const signedNonce = await AuthStore.signNonce(sigPrivKeyBytes, nonce);

    const verifyRes = await fetch(`${serverUrl}/auth/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, signedNonce }),
    });

    if (!verifyRes.ok) {
      const body = await verifyRes.json() as { error?: string };
      throw new Error(body.error ?? `Nonce verification failed (${verifyRes.status})`);
    }

    const {
      username: verifiedUsername,
      enc_pubkey,
      sig_pubkey,
    } = await verifyRes.json() as {
      username: string;
      enc_pubkey: string;
      sig_pubkey: string;
    };

    // Now import both private keys alongside their matching public keys.
    // The keys are imported as non-extractable — they can sign/decrypt
    // but cannot be read back out.
    await tempCrypto.importPrivateKeys(encPrivKeyBytes, sigPrivKeyBytes, enc_pubkey, sig_pubkey);

    const session: Session = {
      userId,
      username: verifiedUsername,
      serverUrl,
      enc_pubkey,
      sig_pubkey,
      clientCrypto: tempCrypto,
    };

    this.session = session;
    return session;
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  /**
   * Clear the current session.
   *
   * The private keys (CryptoKeys) are not explicitly destroyed here —
   * they become unreachable and will be garbage-collected. WebCrypto
   * keys stored as non-extractable CryptoKeys are scoped to the
   * browsing context and cannot be recovered after the reference drops.
   */
  logout(): void {
    this.session = null;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getSession(): Session | null {
    return this.session;
  }

  isLoggedIn(): boolean {
    return this.session !== null;
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Import only the signing private key (no public key needed) and sign
   * the nonce bytes. This is used during login before we have the public
   * keys back from the server.
   *
   * We import the key as extractable=false with ["sign"] usage only,
   * then discard it once we have the signature. The full import
   * (with public key) happens after /login/verify succeeds.
   *
   * @param sigPrivKeyBytes - Decrypted PKCS8 DER bytes of the signing private key
   * @param nonce           - base64url-encoded nonce from the server
   * @returns base64url-encoded RSA-PSS signature over the raw nonce bytes
   */
  private static async signNonce(
    sigPrivKeyBytes: Uint8Array<ArrayBuffer>,
    nonce: string,
  ): Promise<string> {
    // Import only what we need: the private signing key
    const sigPrivKey = await crypto.subtle.importKey(
      "pkcs8",
      sigPrivKeyBytes,
      { name: "RSA-PSS", hash: "SHA-256" },
      false,
      ["sign"],
    );

    // Sign the raw nonce bytes (not the base64url string).
    // The server verifies against the raw bytes, so we must sign those.
    const nonceBytes = fromBase64Url(nonce);
    const signature = await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      sigPrivKey,
      nonceBytes,
    );

    return toBase64Url(new Uint8Array(signature));
  }
}
