import { describe, it, expect } from "vitest";
import { toBase64Url, fromBase64Url } from "../src/encoding.js";

describe("toBase64Url / fromBase64Url", () => {
  it("roundtrips arbitrary bytes", () => {
    // Create some sample bytes and verify encode -> decode gives back the same data.
    const original = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const encoded = toBase64Url(original);
    const decoded = fromBase64Url(encoded);
    expect(decoded).toEqual(original);
  });

  it("produces no padding characters", () => {
    // base64url must NOT include '=' padding per the spec.
    // Test with lengths that would produce padding in standard base64:
    // 1 byte -> standard base64 would be "XX==" (2 padding chars)
    // 2 bytes -> standard base64 would be "XXX=" (1 padding char)
    const oneByteEncoded = toBase64Url(new Uint8Array([42]));
    const twoBytesEncoded = toBase64Url(new Uint8Array([42, 43]));
    expect(oneByteEncoded).not.toContain("=");
    expect(twoBytesEncoded).not.toContain("=");
  });

  it("uses URL-safe characters (- and _ instead of + and /)", () => {
    // The bytes [251, 255] in standard base64 produce "+/8" which
    // in base64url become "-_8". Let's verify no + or / appear.
    const encoded = toBase64Url(new Uint8Array([251, 255]));
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  it("handles empty input", () => {
    const encoded = toBase64Url(new Uint8Array([]));
    expect(encoded).toBe("");
    const decoded = fromBase64Url("");
    expect(decoded).toEqual(new Uint8Array([]));
  });

  it("roundtrips a UTF-8 string encoded as bytes", () => {
    // Simulate encoding a text message as bytes, which is what
    // we'll do with payloads before encrypting them.
    const text = "Hello, mesh-chat!";
    const bytes = new TextEncoder().encode(text);
    const encoded = toBase64Url(bytes);
    const decoded = fromBase64Url(encoded);
    const result = new TextDecoder().decode(decoded);
    expect(result).toBe(text);
  });
});
