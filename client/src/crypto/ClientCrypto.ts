import { toBase64Url, fromBase64Url } from "@mesh-chat/common";

/**
 * Client-side cryptography using the WebCrypto API.
 *
 * Each user owns TWO RSA-4096 key pairs:
 *
 *   1. Encryption pair (RSA-OAEP, SHA-256)
 *      - Public key:  given to other users so they can encrypt messages TO us
 *      - Private key: used to decrypt messages FROM other users
 *
 *   2. Signing pair (RSASSA-PSS, SHA-256, saltLength 32)
 *      - Public key:  given to other users so they can verify our signatures
 *      - Private key: used to sign outgoing ciphertext (content_sig)
 *
 * Why two separate pairs?
 *   RSA-OAEP and RSASSA-PSS are different algorithms with different
 *   key usages. WebCrypto enforces this — a key imported for "encrypt"
 *   cannot be used to "sign". Having two pairs is the correct design.
 *
 * Key format conventions:
 *   - Public keys:  exported as SPKI DER → base64url (stored in server DB)
 *   - Private keys: exported as PKCS8 DER → encrypted by KeyManager → stored
 *                   as blobs in server DB
 *   - All binary values in JSON use base64url (no padding)
 *
 * After login, private keys are imported as **non-extractable** CryptoKeys
 * and held in memory (session storage). This means:
 *   - JavaScript cannot read the raw key bytes back out
 *   - The browser's crypto engine holds them securely
 *   - They're gone when the tab closes (no persistent exposure)
 */
export class ClientCrypto {
  /** RSA-OAEP key pair for encrypt/decrypt. */
  private encKeyPair: CryptoKeyPair | null = null;

  /** RSASSA-PSS key pair for sign/verify. */
  private sigKeyPair: CryptoKeyPair | null = null;

  // ── Key Generation (Registration) ──────────────────────────────────────────

  /**
   * Generate both RSA-4096 key pairs.
   *
   * Called once during user registration. The keys are generated as
   * **extractable** so we can export the private keys for encrypted
   * storage on the server. After login, private keys are re-imported
   * as non-extractable.
   *
   * RSA-4096 keygen is slow (~1-3 seconds in a browser). There's no
   * way around this — it's the cost of strong RSA keys.
   */
  async generateKeyPairs(): Promise<void> {
    // Generate RSA-OAEP pair (encryption/decryption)
    //   - modulusLength: 4096 bits (spec requirement)
    //   - publicExponent: 65537 (standard, written as Uint8Array [1, 0, 1])
    //   - hash: SHA-256 (used internally by OAEP padding)
    //   - extractable: true (so we can export private key for encrypted storage)
    //   - usages: encrypt (public) + decrypt (private)
    this.encKeyPair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,                    // extractable — needed for export
      ["encrypt", "decrypt"],  // public encrypts, private decrypts
    );

    // Generate RSASSA-PSS pair (signing/verification)
    //   - Same RSA-4096 params but different algorithm
    //   - usages: sign (private) + verify (public)
    this.sigKeyPair = await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
  }

  // ── Key Export ─────────────────────────────────────────────────────────────

  /**
   * Export both public keys as base64url strings (SPKI format).
   *
   * SPKI (Subject Public Key Info) is a standard ASN.1 format for public
   * keys. It's the same format the server uses, so keys are interoperable.
   *
   * @returns { enc_pubkey, sig_pubkey } — both base64url-encoded
   */
  async exportPublicKeys(): Promise<{ enc_pubkey: string; sig_pubkey: string }> {
    this.assertKeysExist();

    // subtle.exportKey("spki", key) returns an ArrayBuffer of DER-encoded SPKI
    const encPub = await crypto.subtle.exportKey("spki", this.encKeyPair!.publicKey);
    const sigPub = await crypto.subtle.exportKey("spki", this.sigKeyPair!.publicKey);

    return {
      enc_pubkey: toBase64Url(new Uint8Array(encPub)),
      sig_pubkey: toBase64Url(new Uint8Array(sigPub)),
    };
  }

  /**
   * Export both private keys as raw PKCS8 DER byte arrays.
   *
   * PKCS8 is the standard format for private keys. These raw bytes will
   * be encrypted by KeyManager (Argon2id + AES-256-GCM) before being
   * sent to the server for storage.
   *
   * @returns { encPrivKey, sigPrivKey } — raw Uint8Array (not yet encrypted)
   */
  async exportPrivateKeys(): Promise<{ encPrivKey: Uint8Array<ArrayBuffer>; sigPrivKey: Uint8Array<ArrayBuffer> }> {
    this.assertKeysExist();

    const encPriv = await crypto.subtle.exportKey("pkcs8", this.encKeyPair!.privateKey);
    const sigPriv = await crypto.subtle.exportKey("pkcs8", this.sigKeyPair!.privateKey);

    return {
      encPrivKey: new Uint8Array(encPriv),
      sigPrivKey: new Uint8Array(sigPriv),
    };
  }

  // ── Key Import (Login) ────────────────────────────────────────────────────

  /**
   * Import private keys from decrypted PKCS8 DER bytes.
   *
   * Called during login after KeyManager decrypts the encrypted blobs
   * from the server. The keys are imported as **non-extractable** —
   * once in memory, JavaScript cannot read the raw bytes back out.
   *
   * We also need the public keys for verify/encrypt operations involving
   * our own keys (e.g., verifying our own signatures in tests). The
   * public key b64 strings come from the server's database.
   *
   * @param encPrivKeyBytes - Decrypted RSA-OAEP private key (PKCS8 DER)
   * @param sigPrivKeyBytes - Decrypted RSASSA-PSS private key (PKCS8 DER)
   * @param encPubKeyB64    - RSA-OAEP public key (base64url SPKI)
   * @param sigPubKeyB64    - RSASSA-PSS public key (base64url SPKI)
   */
  async importPrivateKeys(
    encPrivKeyBytes: Uint8Array<ArrayBuffer>,
    sigPrivKeyBytes: Uint8Array<ArrayBuffer>,
    encPubKeyB64: string,
    sigPubKeyB64: string,
  ): Promise<void> {
    // Import encryption private key (RSA-OAEP, non-extractable)
    const encPrivKey = await crypto.subtle.importKey(
      "pkcs8",
      encPrivKeyBytes,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,        // non-extractable — cannot be read back
      ["decrypt"],  // only the private key operation
    );

    // Import encryption public key (for completeness — we may need it
    // to encrypt messages to ourselves or for testing)
    const encPubKey = await crypto.subtle.importKey(
      "spki",
      fromBase64Url(encPubKeyB64),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );

    this.encKeyPair = { privateKey: encPrivKey, publicKey: encPubKey };

    // Import signing private key (RSASSA-PSS, non-extractable)
    const sigPrivKey = await crypto.subtle.importKey(
      "pkcs8",
      sigPrivKeyBytes,
      { name: "RSA-PSS", hash: "SHA-256" },
      false,
      ["sign"],
    );

    // Import signing public key
    const sigPubKey = await crypto.subtle.importKey(
      "spki",
      fromBase64Url(sigPubKeyB64),
      { name: "RSA-PSS", hash: "SHA-256" },
      false,
      ["verify"],
    );

    this.sigKeyPair = { privateKey: sigPrivKey, publicKey: sigPubKey };
  }

  // ── Encryption / Decryption (RSA-OAEP) ───────────────────────────────────

  /**
   * Encrypt plaintext using a recipient's RSA-OAEP public key.
   *
   * RSA-OAEP with SHA-256 and a 4096-bit key can encrypt a maximum of
   * 446 bytes of plaintext. The client UI must enforce this limit.
   *
   * @param plaintext  - UTF-8 string to encrypt (max 446 bytes)
   * @param pubKeyB64  - Recipient's RSA-OAEP public key (base64url SPKI)
   * @returns base64url-encoded ciphertext
   */
  static async encrypt(plaintext: string, pubKeyB64: string): Promise<string> {
    const pubKey = await crypto.subtle.importKey(
      "spki",
      fromBase64Url(pubKeyB64),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );

    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      pubKey,
      encoded,
    );

    return toBase64Url(new Uint8Array(ciphertext));
  }

  /**
   * Decrypt ciphertext using our RSA-OAEP private key.
   *
   * @param ciphertextB64 - base64url-encoded ciphertext from encrypt()
   * @returns Decrypted UTF-8 plaintext
   */
  async decrypt(ciphertextB64: string): Promise<string> {
    this.assertKeysExist();

    const ciphertext = fromBase64Url(ciphertextB64);
    const plaintext = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      this.encKeyPair!.privateKey,
      ciphertext,
    );

    return new TextDecoder().decode(plaintext);
  }

  // ── Signing / Verification (RSASSA-PSS) ──────────────────────────────────

  /**
   * Sign data with our RSASSA-PSS private key.
   *
   * Per spec, the content_sig covers SHA256(ciphertext). We sign the
   * ciphertext string bytes directly — RSASSA-PSS internally hashes
   * with SHA-256, so the effective coverage is:
   * PSS-Sign(SHA256(ciphertext_utf8_bytes)).
   *
   * @param data - The data to sign (typically the ciphertext base64url string)
   * @returns base64url-encoded signature
   */
  async sign(data: string): Promise<string> {
    this.assertKeysExist();

    const encoded = new TextEncoder().encode(data);
    const signature = await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      this.sigKeyPair!.privateKey,
      encoded,
    );

    return toBase64Url(new Uint8Array(signature));
  }

  /**
   * Sign raw bytes with our RSASSA-PSS private key.
   *
   * Used for the login nonce challenge: the server sends a base64url
   * nonce, the client decodes it to raw bytes and signs those bytes.
   * The server then verifies against those same raw bytes. Passing
   * the nonce string through sign() would sign the UTF-8 encoding of
   * the base64url characters — not the underlying bytes — which would
   * fail verification.
   *
   * @param bytes - Raw bytes to sign (e.g. fromBase64Url(nonce))
   * @returns base64url-encoded signature
   */
  async signBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    this.assertKeysExist();

    const signature = await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      this.sigKeyPair!.privateKey,
      bytes,
    );

    return toBase64Url(new Uint8Array(signature));
  }

  /**
   * Verify a signature using a sender's RSASSA-PSS public key.
   *
   * @param data       - The original signed data (e.g., ts as a string)
   * @param sigB64     - base64url-encoded signature to verify
   * @param pubKeyB64  - Sender's RSASSA-PSS public key (base64url SPKI)
   * @returns true if the signature is valid
   */
  static async verify(data: string, sigB64: string, pubKeyB64: string): Promise<boolean> {
    const pubKey = await crypto.subtle.importKey(
      "spki",
      fromBase64Url(pubKeyB64),
      { name: "RSA-PSS", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const encoded = new TextEncoder().encode(data);
    const signature = fromBase64Url(sigB64);

    return crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: 32 },
      pubKey,
      signature,
      encoded,
    );
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Get the signing public key as a CryptoKey (for local use). */
  getSigningPublicKey(): CryptoKey {
    this.assertKeysExist();
    return this.sigKeyPair!.publicKey;
  }

  /** Get the encryption public key as a CryptoKey (for local use). */
  getEncryptionPublicKey(): CryptoKey {
    this.assertKeysExist();
    return this.encKeyPair!.publicKey;
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  private assertKeysExist(): void {
    if (!this.encKeyPair || !this.sigKeyPair) {
      throw new Error("Keys not initialised. Call generateKeyPairs() or importPrivateKeys() first.");
    }
  }
}
