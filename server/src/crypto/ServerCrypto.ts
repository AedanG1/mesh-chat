import { toBase64Url, fromBase64Url } from "@mesh-chat/common";

/**
 * Handles all server-side cryptographic operations using the WebCrypto API.
 *
 * Each server has exactly ONE RSASSA-PSS keypair used to sign
 * transport-level messages (the `sig` field in every Envelope).
 * Other servers verify these signatures using the public key
 * exchanged during SERVER_HELLO_JOIN / SERVER_WELCOME.
 *
 * Why WebCrypto instead of Node's legacy crypto module?
 *   Both the client and server now use the same crypto.subtle API.
 *   This eliminates subtle incompatibilities between Node's crypto
 *   and the browser's WebCrypto (different key formats, padding
 *   options, etc.) and makes the codebase more consistent.
 *
 * Key concepts:
 * - RSA-PSS is a signature algorithm (sign + verify only, NOT encryption).
 * - SHA-256 is the hash algorithm used within the signature scheme.
 * - saltLength: 32 bytes (matching the SHA-256 digest size).
 * - The private key never leaves this server.
 * - The public key is shared with all servers on the network.
 */
export class ServerCrypto {
  private privateKey: CryptoKey;
  private publicKey: CryptoKey;
  private publicKeyB64: string; // cached base64url-encoded public key for the wire

  /**
   * Creates a ServerCrypto instance by generating a fresh RSA-4096 keypair.
   *
   * This is async because WebCrypto key generation returns a Promise.
   * RSA-4096 generation can take 1-3 seconds — unavoidable cost of
   * strong RSA keys.
   */
  static async create(): Promise<ServerCrypto> {
    // generateKey() returns a CryptoKeyPair: { publicKey, privateKey }.
    //
    // Parameters:
    //   name: "RSA-PSS" — the PSS signature scheme (not PKCS#1 v1.5)
    //   modulusLength: 4096 — key size in bits (spec requirement)
    //   publicExponent: [1, 0, 1] — standard 65537
    //   hash: "SHA-256" — hash algorithm used internally by PSS
    //   extractable: true — we need to export the public key to base64url
    //   usages: ["sign", "verify"] — the private key signs, the public key verifies
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,                  // extractable — needed for public key export
      ["sign", "verify"],    // private key signs, public key verifies
    );

    // Export the public key as SPKI DER → base64url for the wire protocol.
    // SPKI (Subject Public Key Info) is a standard ASN.1 format.
    const pubDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const publicKeyB64 = toBase64Url(new Uint8Array(pubDer));

    return new ServerCrypto(keyPair.publicKey, keyPair.privateKey, publicKeyB64);
  }

  private constructor(publicKey: CryptoKey, privateKey: CryptoKey, publicKeyB64: string) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.publicKeyB64 = publicKeyB64;
  }

  /** Returns the server's public key as a base64url string (for the wire protocol). */
  getPublicKeyB64(): string {
    return this.publicKeyB64;
  }

  /**
   * Sign data using this server's private RSA-PSS key.
   *
   * Now async because crypto.subtle.sign returns a Promise.
   *
   * @param data - The bytes to sign (typically from canonicalizePayload)
   * @returns The signature as a base64url string
   */
  async sign(data: Uint8Array<ArrayBuffer>): Promise<string> {
    // crypto.subtle.sign() applies SHA-256 internally (specified in the
    // key's algorithm.hash), then signs with RSA-PSS padding.
    // saltLength: 32 matches the SHA-256 digest size (recommended).
    const signature = await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      this.privateKey,
      data,
    );
    return toBase64Url(new Uint8Array(signature));
  }

  /**
   * Verify a signature against a public key.
   *
   * Used to verify transport signatures from other servers.
   * The public key comes from the SERVER_WELCOME / SERVER_ANNOUNCE
   * payload and is pinned to the server's UUID.
   *
   * Now async because both importKey and verify return Promises.
   *
   * @param data         - The original signed bytes
   * @param signature    - The base64url-encoded signature to verify
   * @param publicKeyB64 - The signer's base64url-encoded public key (DER/SPKI)
   * @returns true if the signature is valid
   */
  static async verify(
    data: Uint8Array<ArrayBuffer>,
    signature: string,
    publicKeyB64: string,
  ): Promise<boolean> {
    try {
      // Reconstruct the CryptoKey from the base64url-encoded SPKI DER bytes.
      // The key is imported as non-extractable with "verify" usage only.
      const pubDer = fromBase64Url(publicKeyB64);
      const publicKey = await crypto.subtle.importKey(
        "spki",
        pubDer,
        { name: "RSA-PSS", hash: "SHA-256" },
        false,       // non-extractable
        ["verify"],  // only need verify usage
      );

      const sigBytes = fromBase64Url(signature);

      return await crypto.subtle.verify(
        { name: "RSA-PSS", saltLength: 32 },
        publicKey,
        sigBytes,
        data,
      );
    } catch {
      // Malformed base64url, invalid key bytes, or corrupt signature bytes
      // all surface as thrown errors. For verification purposes these are
      // the same as an invalid signature — return false.
      return false;
    }
  }

  /**
   * Produce a deterministic byte representation of a payload object.
   *
   * The spec requires that transport signatures cover the payload
   * "canonicalised with JSON key sort; no whitespace variation."
   * This means both the signer and verifier must serialize the
   * payload to the exact same bytes.
   *
   * We achieve this by using JSON.stringify with a replacer that
   * sorts object keys alphabetically. This handles nested objects too.
   *
   * @param payload - The payload object from an Envelope
   * @returns A Uint8Array containing the canonical JSON bytes (UTF-8)
   */
  static canonicalizePayload(payload: Record<string, unknown>): Uint8Array<ArrayBuffer> {
    // JSON.stringify's replacer receives every key. When we return
    // Object.keys(value).sort() for object values, it forces alphabetical
    // key order at every nesting level.
    const canonical = JSON.stringify(payload, (_key, value) => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
          sorted[k] = (value as Record<string, unknown>)[k];
        }
        return sorted;
      }
      return value;
    });

    return new TextEncoder().encode(canonical);
  }
}
