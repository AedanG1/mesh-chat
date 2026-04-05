import crypto from "node:crypto";
import { toBase64Url, fromBase64Url } from "@mesh-chat/common";

/**
 * Handles all server-side cryptographic operations.
 *
 * Each server has exactly ONE RSASSA-PSS keypair used to sign
 * transport-level messages (the `sig` field in every Envelope).
 * Other servers verify these signatures using the public key
 * exchanged during SERVER_HELLO_JOIN / SERVER_WELCOME.
 *
 * Key concepts:
 * - RSASSA-PSS is a signature algorithm (sign + verify only, NOT encryption).
 * - SHA-256 is the hash algorithm used within the signature scheme.
 * - The private key never leaves this server.
 * - The public key is shared with all servers on the network.
 */
export class ServerCrypto {
  private privateKey: crypto.KeyObject;
  private publicKey: crypto.KeyObject;
  private publicKeyB64: string; // cached base64url-encoded public key for the wire

  /**
   * Creates a ServerCrypto instance by generating a fresh RSA-4096 keypair.
   *
   * This is async because key generation is CPU-intensive and we use
   * the async variant to avoid blocking the event loop on startup.
   */
  static async create(): Promise<ServerCrypto> {
    const { publicKey, privateKey } = await new Promise<{
      publicKey: crypto.KeyObject;
      privateKey: crypto.KeyObject;
    }>((resolve, reject) => {
      // generateKeyPair (async version) generates the keypair in a
      // background thread so it doesn't block the main event loop.
      // RSA-4096 key generation can take a noticeable amount of time.
      //
      // We use "rsa" (not "rsa-pss") because @types/node v25 removed
      // the "rsa-pss" overload. PSS padding is applied at sign/verify
      // time instead, which achieves the same RSASSA-PSS behavior.
      crypto.generateKeyPair(
        "rsa",
        {
          modulusLength: 4096,
          publicKeyEncoding: { type: "spki", format: "der" },
          privateKeyEncoding: { type: "pkcs8", format: "der" },
        },
        (err, publicKeyDer, privateKeyDer) => {
          if (err) {
            reject(err);
            return;
          }
          // Convert the DER-encoded buffers back into KeyObject instances.
          // This gives us proper KeyObject types for sign/verify operations.
          const pubKey = crypto.createPublicKey({
            key: publicKeyDer,
            format: "der",
            type: "spki",
          });
          const privKey = crypto.createPrivateKey({
            key: privateKeyDer,
            format: "der",
            type: "pkcs8",
          });
          resolve({ publicKey: pubKey, privateKey: privKey });
        }
      );
    });

    return new ServerCrypto(publicKey, privateKey);
  }

  private constructor(publicKey: crypto.KeyObject, privateKey: crypto.KeyObject) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;

    // Export the public key as DER (binary) format, then encode to base64url.
    // DER is a compact binary encoding of the key -- more space-efficient
    // than PEM which is base64-wrapped DER with header/footer lines.
    const pubDer = publicKey.export({ type: "spki", format: "der" });
    this.publicKeyB64 = toBase64Url(new Uint8Array(pubDer));
  }

  /** Returns the server's public key as a base64url string (for the wire protocol). */
  getPublicKeyB64(): string {
    return this.publicKeyB64;
  }

  /**
   * Sign data using this server's private RSASSA-PSS key.
   *
   * @param data - The bytes to sign (typically from canonicalizePayload)
   * @returns The signature as a base64url string
   */
  sign(data: Buffer): string {
    // crypto.sign() takes the hash algorithm, the data, and a signing options
    // object. We explicitly specify RSA-PSS padding with SHA-256 and a salt
    // length of 32 bytes (matching the SHA-256 digest size).
    const signature = crypto.sign("sha256", data, {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
    return toBase64Url(new Uint8Array(signature));
  }

  /**
   * Verify a signature against a public key.
   *
   * Used to verify transport signatures from other servers.
   * The public key comes from the SERVER_WELCOME / SERVER_ANNOUNCE
   * payload and is pinned to the server's UUID.
   *
   * @param data      - The original signed bytes
   * @param signature - The base64url-encoded signature to verify
   * @param publicKeyB64 - The signer's base64url-encoded public key (DER/SPKI)
   * @returns true if the signature is valid
   */
  static verify(data: Buffer, signature: string, publicKeyB64: string): boolean {
    // Reconstruct the KeyObject from the base64url-encoded DER bytes.
    const pubDer = Buffer.from(fromBase64Url(publicKeyB64));
    const publicKey = crypto.createPublicKey({
      key: pubDer,
      format: "der",
      type: "spki",
    });

    const sigBytes = Buffer.from(fromBase64Url(signature));

    // Verify using RSASSA-PSS padding with the same SHA-256 hash and
    // 32-byte salt length that was used during signing.
    return crypto.verify("sha256", data, {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, sigBytes);
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
   * @returns A Buffer containing the canonical JSON bytes (UTF-8)
   */
  static canonicalizePayload(payload: Record<string, unknown>): Buffer {
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

    return Buffer.from(canonical, "utf-8");
  }
}
