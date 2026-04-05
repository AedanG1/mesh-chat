import { toBase64Url } from "@mesh-chat/common";

/**
 * Client-side password hashing using HMAC-SHA256.
 *
 * The spec requires the client to hash the password before sending it
 * to the server: `HMAC-SHA256(username, password)`. The server then
 * runs Argon2id on top of this client hash — a "double-hash" scheme.
 *
 * Why HMAC and not a plain SHA-256?
 *   - HMAC takes a key + message. We use the username as the key and
 *     the password as the message.
 *   - This binds the hash to the username: same password + different
 *     username → different hash. If two users pick "password123",
 *     the server sees different client hashes.
 *   - HMAC also provides resistance against length-extension attacks
 *     (not critical here but comes for free).
 *
 * Why WebCrypto (`crypto.subtle`)?
 *   - It's built into every modern browser — no library needed.
 *   - HMAC-SHA256 is a native operation: fast and constant-time.
 *
 * The output is base64url (no padding) to match the project's encoding
 * convention for all binary values in JSON.
 */
export class PasswordHasher {
  /**
   * Compute HMAC-SHA256(username, password) and return the result as
   * a base64url string.
   *
   * @param username - Used as the HMAC key
   * @param password - Used as the HMAC message
   * @returns base64url-encoded 32-byte HMAC digest
   */
  static async hash(username: string, password: string): Promise<string> {
    // 1. Encode both strings as UTF-8 byte arrays.
    //    TextEncoder always produces UTF-8, which is what we want.
    const encoder = new TextEncoder();
    const keyData = encoder.encode(username);
    const messageData = encoder.encode(password);

    // 2. Import the username bytes as an HMAC-SHA256 key.
    //    "sign" usage means we can call subtle.sign() with this key.
    //    The key is not extractable — we never need to export it.
    const hmacKey = await crypto.subtle.importKey(
      "raw",            // format: raw bytes
      keyData,          // the key material (username)
      {
        name: "HMAC",
        hash: "SHA-256", // HMAC using SHA-256 as the inner hash
      },
      false,            // not extractable
      ["sign"],         // we only need to "sign" (= compute HMAC)
    );

    // 3. "Sign" the password with the HMAC key.
    //    For HMAC, "signing" is really just computing the MAC —
    //    there's no asymmetric crypto involved. The result is a
    //    32-byte ArrayBuffer (SHA-256 output size).
    const digest = await crypto.subtle.sign("HMAC", hmacKey, messageData);

    // 4. Convert to base64url (our standard encoding for binary-in-JSON).
    return toBase64Url(new Uint8Array(digest));
  }
}
