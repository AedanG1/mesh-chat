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
 * These functions use btoa/atob which are available in both modern browsers
 * and Node.js 16+. This keeps common/ browser-compatible.
 */

/**
 * Encode raw bytes to a base64url string (no padding).
 *
 * Steps:
 *   1. Convert the Uint8Array to a binary string (one char per byte).
 *   2. btoa() converts that binary string to standard base64.
 *   3. Swap the two non-URL-safe characters (+ → -, / → _) and strip padding.
 *
 * @param bytes - The raw binary data to encode
 * @returns A base64url-encoded string without trailing "=" padding
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Decode a base64url string back to raw bytes.
 *
 * Steps:
 *   1. Reverse the character substitutions (- → +, _ → /).
 *   2. Re-add the "=" padding that was stripped (atob requires it).
 *   3. atob() converts the standard base64 string to a binary string.
 *   4. Copy each character code into a Uint8Array.
 *
 * @param str - A base64url-encoded string (with or without padding)
 * @returns The decoded bytes as a Uint8Array
 */
export function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  const base64 = str
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes as Uint8Array<ArrayBuffer>;
}
