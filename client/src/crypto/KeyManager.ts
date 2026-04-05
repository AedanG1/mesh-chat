import { argon2id } from "hash-wasm";
import { toBase64Url, fromBase64Url } from "@mesh-chat/common";

/**
 * Encrypts and decrypts RSA private key blobs using a password-derived key.
 *
 * Encryption scheme:
 *   1. KDF: Argon2id(password, salt) → 256-bit AES key
 *   2. Cipher: AES-256-GCM(key, iv, plaintext) → ciphertext + auth tag
 *
 * Blob format (stored on the server as base64url):
 *   ┌──────────┬──────────┬────────────────────────────────────────┐
 *   │ salt(16) │ iv(12)   │ ciphertext (includes 16-byte GCM tag) │
 *   └──────────┴──────────┴────────────────────────────────────────┘
 *
 * To decrypt, the client slices the blob at fixed offsets to recover
 * the salt and IV, then re-derives the same AES key from the password.
 *
 * Why Argon2id?
 *   It's a memory-hard KDF designed to resist GPU/ASIC attacks. Even
 *   if the encrypted blob leaks, brute-forcing the password requires
 *   significant memory per guess. We use `hash-wasm` which is a pure
 *   WASM implementation — works in the browser without native bindings.
 *
 * Why AES-256-GCM?
 *   GCM provides both confidentiality (encryption) and integrity
 *   (authentication). If anyone tampers with the ciphertext, decryption
 *   fails rather than producing garbage. WebCrypto supports it natively.
 *
 * Blob byte offsets:
 *   - Bytes  0..15  → Argon2id salt (16 bytes)
 *   - Bytes 16..27  → AES-GCM IV    (12 bytes)
 *   - Bytes 28..end → AES-GCM ciphertext (includes 16-byte auth tag)
 */

/** Fixed byte sizes for the blob layout. */
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * Argon2id parameters.
 *
 * These are tuned for browser performance — lower than server-side
 * recommendations because we run in a single browser thread.
 *   - parallelism: 1 (WASM is single-threaded in most browsers)
 *   - iterations:  3 (time cost — how many passes over memory)
 *   - memorySize:  65536 KB = 64 MB (memory cost)
 *   - hashLength:  32 bytes = 256 bits (matches AES-256 key size)
 */
const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // 64 MB in KB
  hashLength: 32,    // 256-bit AES key
} as const;

export class KeyManager {
  // ── Encrypt ──────────────────────────────────────────────────────────────

  /**
   * Encrypt a private key with a password-derived key.
   *
   * @param privateKeyBytes - Raw PKCS8 DER bytes of the private key
   * @param password        - The user's plaintext password (used for KDF)
   * @returns base64url-encoded blob: salt | iv | ciphertext
   */
  static async encryptPrivateKey(
    privateKeyBytes: Uint8Array<ArrayBuffer>,
    password: string,
  ): Promise<string> {
    // 1. Generate random salt and IV.
    //    crypto.getRandomValues is available in all browsers and in Node 19+.
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

    // 2. Derive AES-256 key from password + salt using Argon2id.
    const aesKey = await KeyManager.deriveKey(password, salt);

    // 3. Encrypt the private key bytes with AES-256-GCM.
    //    GCM automatically appends a 16-byte authentication tag to
    //    the ciphertext. We don't need to manage it separately.
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      privateKeyBytes,
    );

    // 4. Pack: salt(16) | iv(12) | ciphertext(...)
    const blob = new Uint8Array(SALT_BYTES + IV_BYTES + ciphertext.byteLength);
    blob.set(salt, 0);
    blob.set(iv, SALT_BYTES);
    blob.set(new Uint8Array(ciphertext), SALT_BYTES + IV_BYTES);

    return toBase64Url(blob);
  }

  // ── Decrypt ──────────────────────────────────────────────────────────────

  /**
   * Decrypt a private key blob using the user's password.
   *
   * @param blobB64  - base64url-encoded blob from encryptPrivateKey()
   * @param password - The user's plaintext password
   * @returns Decrypted PKCS8 DER bytes of the private key
   * @throws If the password is wrong (GCM auth tag verification fails)
   */
  static async decryptPrivateKey(
    blobB64: string,
    password: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const blob = fromBase64Url(blobB64);

    // 1. Slice the blob at known byte offsets.
    const salt = blob.slice(0, SALT_BYTES);
    const iv = blob.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
    const ciphertext = blob.slice(SALT_BYTES + IV_BYTES);

    // 2. Re-derive the same AES key from password + salt.
    //    Argon2id is deterministic given the same inputs, so this
    //    produces the exact same 256-bit key as during encryption.
    const aesKey = await KeyManager.deriveKey(password, salt);

    // 3. Decrypt with AES-256-GCM.
    //    If the password is wrong, the derived key is different,
    //    and GCM's authentication check fails → throws an error.
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      aesKey,
      ciphertext,
    );

    return new Uint8Array(plaintext);
  }

  // ── KDF ──────────────────────────────────────────────────────────────────

  /**
   * Derive a 256-bit AES key from a password and salt using Argon2id.
   *
   * Argon2id is the recommended password-hashing/KDF algorithm. It
   * combines Argon2i (data-independent memory access — resists
   * side-channel attacks) with Argon2d (data-dependent — resists
   * GPU brute-force).
   *
   * hash-wasm returns a hex string — we convert it to raw bytes and
   * import it as a WebCrypto AES-GCM key.
   *
   * @param password - The user's plaintext password
   * @param salt     - 16-byte random salt
   * @returns A non-extractable CryptoKey for AES-256-GCM
   */
  private static async deriveKey(
    password: string,
    salt: Uint8Array,
  ): Promise<CryptoKey> {
    // hash-wasm's argon2id returns a hex string of the derived hash.
    const hashHex = await argon2id({
      password,
      salt,
      ...ARGON2_PARAMS,
      outputType: "hex",
    });

    // Convert hex string to raw bytes (32 bytes = 256 bits).
    const keyBytes = new Uint8Array(
      hashHex.match(/.{2}/g)!.map((byte: string) => parseInt(byte, 16)),
    );

    // Import as a WebCrypto AES-GCM key (non-extractable).
    return crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,             // non-extractable
      ["encrypt", "decrypt"],
    );
  }
}
