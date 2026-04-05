import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { toBase64Url } from "@mesh-chat/common";
import { AuthStore } from "../../src/store/AuthStore.js";
import { ClientCrypto } from "../../src/crypto/ClientCrypto.js";
import { KeyManager } from "../../src/crypto/KeyManager.js";

/**
 * AuthStore tests.
 *
 * We stub the global fetch so no real HTTP calls are made.
 * The stub returns pre-built responses that mimic the server.
 *
 * Crypto operations (RSA keygen, Argon2id, AES-GCM) run for real —
 * they're fast enough in Node and make the tests meaningful.
 * Two Argon2id calls per login test ≈ 2s. A 60s timeout is comfortable.
 */
describe("AuthStore", () => {
  let store: AuthStore;
  // A real ClientCrypto used to pre-generate realistic test data
  let realCrypto: ClientCrypto;
  let realPubKeys: { enc_pubkey: string; sig_pubkey: string };
  let realPrivKeyBlobs: { enc_privkey_store: string; sig_privkey_store: string };
  const PASSWORD = "test-password";
  const USERNAME = "alice";
  const USER_ID = "test-user-uuid-1234";

  // Generate keys once — used across multiple tests
  beforeAll(async () => {
    realCrypto = new ClientCrypto();
    await realCrypto.generateKeyPairs();
    realPubKeys = await realCrypto.exportPublicKeys();

    const privKeys = await realCrypto.exportPrivateKeys();
    realPrivKeyBlobs = {
      enc_privkey_store: await KeyManager.encryptPrivateKey(privKeys.encPrivKey, PASSWORD),
      sig_privkey_store: await KeyManager.encryptPrivateKey(privKeys.sigPrivKey, PASSWORD),
    };
  }, 30000);

  beforeEach(() => {
    store = new AuthStore();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Helper: make a mock fetch response ───────────────────────────────────

  function mockFetch(responses: Array<{ status: number; body: unknown }>) {
    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      const resp = responses[callCount++];
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        json: async () => resp.body,
      } as Response;
    });
  }

  // ── register() ───────────────────────────────────────────────────────────

  describe("register()", () => {
    it("sends the correct fields to POST /auth/register and returns userId", async () => {
      mockFetch([{ status: 201, body: { userId: USER_ID } }]);

      const userId = await store.register("http://server", USERNAME, PASSWORD);

      expect(userId).toBe(USER_ID);
      expect(fetch).toHaveBeenCalledOnce();

      const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://server/auth/register");

      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      // All required fields must be present
      expect(typeof body.username).toBe("string");
      expect(typeof body.clientHash).toBe("string");
      expect(typeof body.enc_pubkey).toBe("string");
      expect(typeof body.sig_pubkey).toBe("string");
      expect(typeof body.enc_privkey_store).toBe("string");
      expect(typeof body.sig_privkey_store).toBe("string");
      // clientHash must be a base64url string (32 bytes)
      expect(body.clientHash).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("throws when the server returns a non-2xx status", async () => {
      mockFetch([{ status: 409, body: { error: "Username already taken" } }]);

      await expect(
        store.register("http://server", USERNAME, PASSWORD),
      ).rejects.toThrow("Username already taken");
    });
  });

  // ── login() ──────────────────────────────────────────────────────────────

  describe("login()", () => {
    /**
     * Build a realistic nonce and signed-nonce pair using our real keys.
     * This is what the server would produce and expect.
     */
    async function buildNonce(): Promise<{ nonce: string }> {
      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const nonce = toBase64Url(nonceBytes);
      return { nonce };
    }

    it("establishes a session after a successful login", async () => {
      const { nonce } = await buildNonce();

      mockFetch([
        // POST /auth/login → nonce challenge + encrypted key blobs
        {
          status: 200,
          body: {
            userId: USER_ID,
            nonce,
            enc_privkey_store: realPrivKeyBlobs.enc_privkey_store,
            sig_privkey_store: realPrivKeyBlobs.sig_privkey_store,
          },
        },
        // POST /auth/login/verify → user profile
        {
          status: 200,
          body: {
            userId: USER_ID,
            username: USERNAME,
            enc_pubkey: realPubKeys.enc_pubkey,
            sig_pubkey: realPubKeys.sig_pubkey,
          },
        },
      ]);

      const session = await store.login("http://server", USERNAME, PASSWORD);

      expect(session.userId).toBe(USER_ID);
      expect(session.username).toBe(USERNAME);
      expect(session.enc_pubkey).toBe(realPubKeys.enc_pubkey);
      expect(session.sig_pubkey).toBe(realPubKeys.sig_pubkey);
      expect(session.clientCrypto).toBeInstanceOf(ClientCrypto);
    });

    it("sets isLoggedIn() to true after login", async () => {
      const { nonce } = await buildNonce();
      mockFetch([
        { status: 200, body: { userId: USER_ID, nonce, ...realPrivKeyBlobs } },
        { status: 200, body: { userId: USER_ID, username: USERNAME, ...realPubKeys } },
      ]);

      expect(store.isLoggedIn()).toBe(false);
      await store.login("http://server", USERNAME, PASSWORD);
      expect(store.isLoggedIn()).toBe(true);
    });

    it("throws when POST /auth/login returns 401", async () => {
      mockFetch([{ status: 401, body: { error: "Invalid credentials" } }]);

      await expect(
        store.login("http://server", USERNAME, "wrong-password"),
      ).rejects.toThrow("Invalid credentials");
    });

    it("throws when decrypting key blobs with the wrong password", async () => {
      // Blobs were encrypted with PASSWORD — using the wrong password
      // causes AES-GCM auth tag failure in KeyManager.decryptPrivateKey
      const { nonce } = await buildNonce();
      mockFetch([
        {
          status: 200,
          body: {
            userId: USER_ID,
            nonce,
            enc_privkey_store: realPrivKeyBlobs.enc_privkey_store,
            sig_privkey_store: realPrivKeyBlobs.sig_privkey_store,
          },
        },
      ]);

      // Use the correct username/hash (passes round 1) but wrong plaintext
      // password for the Argon2id KDF step (fails round 2)
      const storeWithWrongPw = new AuthStore();
      // We need to make round 1 pass — mock login to return 200 with real blobs,
      // but the plaintext password used for KDF is wrong.
      // To do this cleanly, we stub only fetch for round 1 and let KDF fail.
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          userId: USER_ID,
          nonce,
          enc_privkey_store: realPrivKeyBlobs.enc_privkey_store,
          sig_privkey_store: realPrivKeyBlobs.sig_privkey_store,
        }),
      } as Response);

      await expect(
        storeWithWrongPw.login("http://server", USERNAME, "completely-wrong-password"),
      ).rejects.toThrow();
    });
  });

  // ── logout() ─────────────────────────────────────────────────────────────

  describe("logout()", () => {
    it("clears the session", async () => {
      const { nonce } = await (async () => {
        const b = crypto.getRandomValues(new Uint8Array(32));
        return { nonce: toBase64Url(b) };
      })();
      mockFetch([
        { status: 200, body: { userId: USER_ID, nonce, ...realPrivKeyBlobs } },
        { status: 200, body: { userId: USER_ID, username: USERNAME, ...realPubKeys } },
      ]);

      await store.login("http://server", USERNAME, PASSWORD);
      expect(store.isLoggedIn()).toBe(true);

      store.logout();
      expect(store.isLoggedIn()).toBe(false);
      expect(store.getSession()).toBeNull();
    });
  });
}, 120000);
