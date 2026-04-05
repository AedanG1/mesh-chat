import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { UserRecord } from "@mesh-chat/common";
import { Database } from "../../src/db/Database.js";
import { UserRepository } from "../../src/auth/UserRepository.js";

/** Helper to build a valid UserRecord for testing. */
function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    user_id: "test-uuid-1234",
    username: "alice",
    enc_pubkey: "enc-pub-key-base64url",
    sig_pubkey: "sig-pub-key-base64url",
    enc_privkey_store: "enc-priv-blob-base64url",
    sig_privkey_store: "sig-priv-blob-base64url",
    dbl_hash_password: "$argon2id$v=19$m=65536,t=3,p=4$fakesalt$fakehash",
    version: 1,
    ...overrides,
  };
}

describe("UserRepository", () => {
  let db: Database;
  let repo: UserRepository;

  // Create a fresh in-memory DB and repository before each test.
  // This ensures tests don't interfere with each other.
  beforeEach(() => {
    db = new Database(":memory:");
    repo = new UserRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("create", () => {
    it("inserts a user record into the database", () => {
      const user = makeUser();
      repo.create(user);

      // Verify it was written by reading it back
      const found = repo.findById(user.user_id);
      expect(found).toBeDefined();
      expect(found!.username).toBe("alice");
      expect(found!.enc_pubkey).toBe("enc-pub-key-base64url");
      expect(found!.sig_pubkey).toBe("sig-pub-key-base64url");
    });

    it("throws on duplicate user_id", () => {
      const user = makeUser();
      repo.create(user);

      // Inserting a second user with the same UUID should fail
      // because user_id is the PRIMARY KEY.
      expect(() => repo.create(user)).toThrow();
    });

    it("throws on duplicate username", () => {
      repo.create(makeUser({ user_id: "uuid-1" }));

      // Same username but different UUID should also fail
      // because of the UNIQUE constraint on username.
      expect(() =>
        repo.create(makeUser({ user_id: "uuid-2", username: "alice" })),
      ).toThrow();
    });
  });

  describe("findByUsername", () => {
    it("returns the user record when found", () => {
      repo.create(makeUser());
      const found = repo.findByUsername("alice");
      expect(found).toBeDefined();
      expect(found!.user_id).toBe("test-uuid-1234");
    });

    it("returns undefined when not found", () => {
      const found = repo.findByUsername("nobody");
      expect(found).toBeUndefined();
    });
  });

  describe("findById", () => {
    it("returns the user record when found", () => {
      repo.create(makeUser());
      const found = repo.findById("test-uuid-1234");
      expect(found).toBeDefined();
      expect(found!.username).toBe("alice");
    });

    it("returns undefined when not found", () => {
      const found = repo.findById("nonexistent-uuid");
      expect(found).toBeUndefined();
    });
  });
});
