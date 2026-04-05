import { describe, it, expect, beforeAll } from "vitest";
import { ServerCrypto } from "../../src/crypto/ServerCrypto.js";

describe("ServerCrypto", () => {
  // RSA-4096 key generation is slow (~1-3 seconds), so we generate
  // the keypair once before all tests in this suite.
  let serverCrypto: ServerCrypto;

  beforeAll(async () => {
    serverCrypto = await ServerCrypto.create();
  });

  describe("key generation", () => {
    it("produces a non-empty base64url public key", () => {
      const pubKey = serverCrypto.getPublicKeyB64();
      expect(typeof pubKey).toBe("string");
      expect(pubKey.length).toBeGreaterThan(0);
      // base64url should not contain standard base64 chars or padding
      expect(pubKey).not.toContain("+");
      expect(pubKey).not.toContain("/");
      expect(pubKey).not.toContain("=");
    });
  });

  describe("sign / verify", () => {
    it("verifies a signature produced by the same server", () => {
      const data = Buffer.from("hello mesh-chat", "utf-8");
      const signature = serverCrypto.sign(data);
      const pubKey = serverCrypto.getPublicKeyB64();

      // Verification should pass with the correct data and key
      expect(ServerCrypto.verify(data, signature, pubKey)).toBe(true);
    });

    it("rejects a signature when the data has been tampered with", () => {
      const data = Buffer.from("original message", "utf-8");
      const signature = serverCrypto.sign(data);
      const pubKey = serverCrypto.getPublicKeyB64();

      // Tamper with the data -- change one byte
      const tampered = Buffer.from("Original message", "utf-8"); // capital O
      expect(ServerCrypto.verify(tampered, signature, pubKey)).toBe(false);
    });

    it("rejects a signature from a different server", async () => {
      const otherServer = await ServerCrypto.create();
      const data = Buffer.from("some data", "utf-8");

      // Sign with the original server's key
      const signature = serverCrypto.sign(data);

      // Try to verify with a different server's public key -- should fail
      const otherPubKey = otherServer.getPublicKeyB64();
      expect(ServerCrypto.verify(data, signature, otherPubKey)).toBe(false);
    });
  });

  describe("canonicalizePayload", () => {
    it("sorts keys alphabetically", () => {
      // Even though "zebra" is inserted before "alpha", the output
      // should have keys in alphabetical order.
      const payload = { zebra: 1, alpha: 2, middle: 3 };
      const canonical = ServerCrypto.canonicalizePayload(payload);
      const parsed = JSON.parse(canonical.toString("utf-8"));

      expect(Object.keys(parsed)).toEqual(["alpha", "middle", "zebra"]);
    });

    it("sorts nested object keys", () => {
      const payload = { outer: { z: 1, a: 2 }, first: true };
      const canonical = ServerCrypto.canonicalizePayload(payload);
      const json = canonical.toString("utf-8");

      // "first" should come before "outer", and within outer "a" before "z"
      expect(json).toBe('{"first":true,"outer":{"a":2,"z":1}}');
    });

    it("produces identical output for objects with same data but different insertion order", () => {
      // This is the critical property: two objects with the same
      // key-value pairs but different insertion order must produce
      // the same canonical form. Without this, signatures would break.
      const payloadA = { host: "10.0.0.1", port: 9000, sig_pubkey: "abc" };
      const payloadB = { sig_pubkey: "abc", host: "10.0.0.1", port: 9000 };

      const canonA = ServerCrypto.canonicalizePayload(payloadA);
      const canonB = ServerCrypto.canonicalizePayload(payloadB);

      expect(canonA).toEqual(canonB);
    });

    it("preserves arrays without reordering", () => {
      // Arrays should be kept as-is (only object keys get sorted).
      const payload = { items: [3, 1, 2], name: "test" };
      const canonical = ServerCrypto.canonicalizePayload(payload);
      const json = canonical.toString("utf-8");

      expect(json).toBe('{"items":[3,1,2],"name":"test"}');
    });
  });

  describe("sign + canonicalize integration", () => {
    it("signs and verifies a canonicalized payload", () => {
      // This simulates the real workflow: canonicalize a payload,
      // sign it, then verify with the public key.
      const payload = { host: "10.0.0.1", port: 9000, sig_pubkey: "key123" };
      const canonical = ServerCrypto.canonicalizePayload(payload);
      const signature = serverCrypto.sign(canonical);
      const pubKey = serverCrypto.getPublicKeyB64();

      expect(ServerCrypto.verify(canonical, signature, pubKey)).toBe(true);
    });
  });
});
