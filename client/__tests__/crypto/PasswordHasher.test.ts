import { describe, it, expect } from "vitest";
import { fromBase64Url } from "@mesh-chat/common";
import { PasswordHasher } from "../../src/crypto/PasswordHasher.js";

describe("PasswordHasher", () => {
  it("produces a base64url string (no padding)", async () => {
    const hash = await PasswordHasher.hash("alice", "password123");

    // base64url characters: A-Z, a-z, 0-9, -, _  (no = padding)
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).not.toContain("=");
  });

  it("output decodes to exactly 32 bytes (SHA-256 digest size)", async () => {
    const hash = await PasswordHasher.hash("alice", "password123");
    const bytes = fromBase64Url(hash);

    // HMAC-SHA256 always produces 32 bytes regardless of input size
    expect(bytes.length).toBe(32);
  });

  it("is deterministic — same inputs produce the same hash", async () => {
    const hash1 = await PasswordHasher.hash("alice", "password123");
    const hash2 = await PasswordHasher.hash("alice", "password123");

    expect(hash1).toBe(hash2);
  });

  it("different usernames produce different hashes (even with the same password)", async () => {
    // This is the key benefit of using username as the HMAC key:
    // the same password "secret" yields different hashes for alice vs bob
    const hashAlice = await PasswordHasher.hash("alice", "secret");
    const hashBob = await PasswordHasher.hash("bob", "secret");

    expect(hashAlice).not.toBe(hashBob);
  });

  it("different passwords produce different hashes (same username)", async () => {
    const hash1 = await PasswordHasher.hash("alice", "password1");
    const hash2 = await PasswordHasher.hash("alice", "password2");

    expect(hash1).not.toBe(hash2);
  });
});
