import { describe, it, expect } from "vitest";
import { fromBase64Url } from "@mesh-chat/common";
import { KeyManager } from "../../src/crypto/KeyManager.js";

/**
 * KeyManager tests.
 *
 * These test the full Argon2id KDF + AES-256-GCM encrypt/decrypt cycle.
 * Argon2id with 64 MB memory takes ~0.5-1s per call, so each test that
 * encrypts + decrypts incurs ~1-2s of KDF time. A 30s timeout covers this.
 */
describe("KeyManager", () => {
  // A fake private key — just some bytes to encrypt/decrypt.
  // In real usage this would be ~2350 bytes of PKCS8 DER.
  const fakePrivateKey = new Uint8Array(256);
  for (let i = 0; i < fakePrivateKey.length; i++) {
    fakePrivateKey[i] = i % 256;
  }

  const PASSWORD = "my-secret-password";

  // ── Blob Structure ────────────────────────────────────────────────────────

  describe("blob format", () => {
    it("produces a base64url string (no padding)", async () => {
      const blob = await KeyManager.encryptPrivateKey(fakePrivateKey, PASSWORD);

      expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(blob).not.toContain("=");
    });

    it("blob decodes to at least salt(16) + iv(12) + some ciphertext", async () => {
      const blob = await KeyManager.encryptPrivateKey(fakePrivateKey, PASSWORD);
      const bytes = fromBase64Url(blob);

      // Minimum size: 16 (salt) + 12 (iv) + 16 (GCM tag) + 1 (at least 1 byte ciphertext)
      // In practice: 16 + 12 + 256 (plaintext) + 16 (tag) = 300
      expect(bytes.length).toBeGreaterThan(28 + 16);

      // For our 256-byte input:
      // AES-GCM ciphertext = plaintext length + 16-byte tag = 272
      // Total blob = 16 + 12 + 272 = 300
      expect(bytes.length).toBe(300);
    });

    it("different encryptions of the same key produce different blobs (random salt/iv)", async () => {
      const blob1 = await KeyManager.encryptPrivateKey(fakePrivateKey, PASSWORD);
      const blob2 = await KeyManager.encryptPrivateKey(fakePrivateKey, PASSWORD);

      // Each call generates a fresh random salt and IV, so the blobs
      // (and therefore the ciphertexts) must differ
      expect(blob1).not.toBe(blob2);
    });
  });

  // ── Encrypt / Decrypt Roundtrip ───────────────────────────────────────────

  describe("encrypt + decrypt roundtrip", () => {
    it("recovers the original private key bytes", async () => {
      const blob = await KeyManager.encryptPrivateKey(fakePrivateKey, PASSWORD);
      const decrypted = await KeyManager.decryptPrivateKey(blob, PASSWORD);

      // Byte-for-byte equality
      expect(decrypted).toEqual(fakePrivateKey);
    });

    it("roundtrips a large key (RSA-4096 PKCS8 is ~2350 bytes)", async () => {
      // Simulate a realistic RSA-4096 private key size
      const largeKey = crypto.getRandomValues(new Uint8Array(2350));
      const blob = await KeyManager.encryptPrivateKey(largeKey, PASSWORD);
      const decrypted = await KeyManager.decryptPrivateKey(blob, PASSWORD);

      expect(decrypted).toEqual(largeKey);
    });
  });

  // ── Wrong Password ────────────────────────────────────────────────────────

  describe("wrong password", () => {
    it("throws when decrypting with the wrong password", async () => {
      const blob = await KeyManager.encryptPrivateKey(fakePrivateKey, PASSWORD);

      // AES-GCM authentication check fails when the derived key is different.
      // WebCrypto throws a DOMException / OperationError.
      await expect(
        KeyManager.decryptPrivateKey(blob, "wrong-password"),
      ).rejects.toThrow();
    });
  });
}, 60000); // generous: Argon2id with 64 MB is slow
