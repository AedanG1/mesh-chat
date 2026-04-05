import { describe, it, expect, beforeAll } from "vitest";
import { fromBase64Url } from "@mesh-chat/common";
import { ClientCrypto } from "../../src/crypto/ClientCrypto.js";

/**
 * ClientCrypto tests.
 *
 * NOTE: RSA-4096 keygen is slow (~1-3s per pair, 2 pairs = 2-6s).
 * We generate keys once in beforeAll and reuse them across tests
 * to keep the suite fast. The 30s timeout at the bottom covers this.
 */
describe("ClientCrypto", () => {
  let clientCrypto: ClientCrypto;
  let exportedPubKeys: { enc_pubkey: string; sig_pubkey: string };

  // Generate keys once — they're reused by all tests in this describe block
  beforeAll(async () => {
    clientCrypto = new ClientCrypto();
    await clientCrypto.generateKeyPairs();
    exportedPubKeys = await clientCrypto.exportPublicKeys();
  });

  // ── Key Generation & Export ───────────────────────────────────────────────

  describe("generateKeyPairs + exportPublicKeys", () => {
    it("exports two distinct base64url public keys", () => {
      // Both should be non-empty base64url strings
      expect(exportedPubKeys.enc_pubkey).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(exportedPubKeys.sig_pubkey).toMatch(/^[A-Za-z0-9_-]+$/);

      // The two keys must be different (different algorithms → different keys)
      expect(exportedPubKeys.enc_pubkey).not.toBe(exportedPubKeys.sig_pubkey);
    });

    it("public keys decode to valid SPKI DER (non-trivial byte length)", () => {
      // RSA-4096 SPKI DER is ~550 bytes. Anything less than 400 is suspicious.
      const encBytes = fromBase64Url(exportedPubKeys.enc_pubkey);
      const sigBytes = fromBase64Url(exportedPubKeys.sig_pubkey);

      expect(encBytes.length).toBeGreaterThan(400);
      expect(sigBytes.length).toBeGreaterThan(400);
    });
  });

  // ── Private Key Export ────────────────────────────────────────────────────

  describe("exportPrivateKeys", () => {
    it("exports two distinct PKCS8 byte arrays", async () => {
      const privKeys = await clientCrypto.exportPrivateKeys();

      // PKCS8 DER for RSA-4096 is ~2350 bytes
      expect(privKeys.encPrivKey.length).toBeGreaterThan(2000);
      expect(privKeys.sigPrivKey.length).toBeGreaterThan(2000);

      // They must be different keys
      const encHex = Buffer.from(privKeys.encPrivKey).toString("hex");
      const sigHex = Buffer.from(privKeys.sigPrivKey).toString("hex");
      expect(encHex).not.toBe(sigHex);
    });
  });

  // ── Encrypt / Decrypt Roundtrip ───────────────────────────────────────────

  describe("encrypt + decrypt", () => {
    it("roundtrips a short message", async () => {
      const plaintext = "Hello, Bob!";

      // Encrypt with our own public key (simulating another user encrypting to us)
      const ciphertext = await ClientCrypto.encrypt(plaintext, exportedPubKeys.enc_pubkey);

      // Ciphertext should be a base64url string
      expect(ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);

      // Decrypt with our private key
      const decrypted = await clientCrypto.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it("roundtrips the maximum 446-byte message", async () => {
      // RSA-OAEP with SHA-256 and 4096-bit key: max plaintext = 446 bytes
      const maxMessage = "A".repeat(446);
      const ciphertext = await ClientCrypto.encrypt(maxMessage, exportedPubKeys.enc_pubkey);
      const decrypted = await clientCrypto.decrypt(ciphertext);

      expect(decrypted).toBe(maxMessage);
    });

    it("rejects plaintext exceeding 446 bytes", async () => {
      const tooLong = "A".repeat(447);

      // RSA-OAEP should throw when plaintext is too large
      await expect(
        ClientCrypto.encrypt(tooLong, exportedPubKeys.enc_pubkey),
      ).rejects.toThrow();
    });

    it("different encryptions of the same plaintext produce different ciphertexts", async () => {
      // RSA-OAEP uses random padding, so identical plaintext → different ciphertext
      const msg = "same message";
      const ct1 = await ClientCrypto.encrypt(msg, exportedPubKeys.enc_pubkey);
      const ct2 = await ClientCrypto.encrypt(msg, exportedPubKeys.enc_pubkey);

      expect(ct1).not.toBe(ct2);
    });
  });

  // ── Sign / Verify Roundtrip ───────────────────────────────────────────────

  describe("sign + verify", () => {
    it("produces a valid signature that verify accepts", async () => {
      const data = String(Date.now()); // simulating the ts field

      const signature = await clientCrypto.sign(data);

      // Signature should be a non-empty base64url string
      expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(signature.length).toBeGreaterThan(0);

      // Verify using our own public key
      const valid = await ClientCrypto.verify(data, signature, exportedPubKeys.sig_pubkey);
      expect(valid).toBe(true);
    });

    it("rejects a signature over different data", async () => {
      const data = "original data";
      const signature = await clientCrypto.sign(data);

      // Tamper with the data
      const valid = await ClientCrypto.verify("tampered data", signature, exportedPubKeys.sig_pubkey);
      expect(valid).toBe(false);
    });

    it("rejects a signature verified with the wrong public key", async () => {
      // Generate a second ClientCrypto with different keys
      const other = new ClientCrypto();
      await other.generateKeyPairs();
      const otherPubKeys = await other.exportPublicKeys();

      const data = "test data";
      const signature = await clientCrypto.sign(data);

      // Verify with the OTHER user's public key — should fail
      const valid = await ClientCrypto.verify(data, signature, otherPubKeys.sig_pubkey);
      expect(valid).toBe(false);
    });
  });

  // ── Import Private Keys (Login Flow) ──────────────────────────────────────

  describe("importPrivateKeys", () => {
    it("imported keys can decrypt and sign just like the originals", async () => {
      // Export the private keys as raw bytes (simulating what KeyManager decrypts)
      const privKeys = await clientCrypto.exportPrivateKeys();

      // Create a new ClientCrypto and import the keys (as login would)
      const restored = new ClientCrypto();
      await restored.importPrivateKeys(
        privKeys.encPrivKey,
        privKeys.sigPrivKey,
        exportedPubKeys.enc_pubkey,
        exportedPubKeys.sig_pubkey,
      );

      // Test decrypt: encrypt with the original public key, decrypt with imported private
      const ciphertext = await ClientCrypto.encrypt("roundtrip test", exportedPubKeys.enc_pubkey);
      const decrypted = await restored.decrypt(ciphertext);
      expect(decrypted).toBe("roundtrip test");

      // Test sign: sign with imported key, verify with original public key
      const sig = await restored.sign("timestamp-123");
      const valid = await ClientCrypto.verify("timestamp-123", sig, exportedPubKeys.sig_pubkey);
      expect(valid).toBe(true);
    });
  });

  describe("error handling", () => {
    it("throws if keys are not initialised", async () => {
      const empty = new ClientCrypto();

      await expect(empty.decrypt("anything")).rejects.toThrow("Keys not initialised");
      await expect(empty.sign("anything")).rejects.toThrow("Keys not initialised");
      expect(() => empty.getSigningPublicKey()).toThrow("Keys not initialised");
    });
  });
}, 30000); // generous: RSA-4096 keygen is slow
