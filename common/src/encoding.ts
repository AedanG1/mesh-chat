/**
 * base64url encoding/decoding utilities.
 *
 * The protocol requires all binary values (keys, ciphertexts, signatures)
 * to be encoded as base64url with NO padding ("=" characters stripped).
 *
 * base64url differs from standard base64 in two character substitutions:
 *   standard base64:  A-Z a-z 0-9 + /
 *   base64url:        A-Z a-z 0-9 - _
 *
 * These functions use Node's Buffer which handles the conversion natively.
 * The client will need a browser-compatible implementation (Phase 7).
 */

/**
 * Encode raw bytes to a base64url string (no padding).
 *
 * @param bytes - The raw binary data to encode
 * @returns A base64url-encoded string without trailing "=" padding
 */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Decode a base64url string back to raw bytes.
 *
 * Handles input with or without padding -- Buffer.from
 * with "base64url" encoding accepts both forms.
 *
 * @param str - A base64url-encoded string
 * @returns The decoded bytes as a Uint8Array
 */
export function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(str, "base64url"));
}
