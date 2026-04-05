import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";
import { PresenceManager } from "../../src/presence/PresenceManager.js";
import { ServerCrypto } from "../../src/crypto/ServerCrypto.js";
import { SeenCache } from "../../src/mesh/SeenCache.js";

/**
 * A minimal fake MeshManager for unit testing PresenceManager.
 *
 * This is a "test double" — it implements only the parts of MeshManager
 * that PresenceManager calls, without any real network logic.
 * We use it to verify that PresenceManager calls broadcast() correctly
 * without needing real WebSocket connections.
 */
function makeFakeMeshManager() {
  return {
    broadcast: vi.fn(),          // spy: tracks calls and arguments
    getPubKey: vi.fn(() => undefined as string | undefined), // no pinned keys in unit tests
  };
}

describe("PresenceManager", () => {
  let pm: PresenceManager;
  let crypto: ServerCrypto;
  let meshManager: ReturnType<typeof makeFakeMeshManager>;
  let seenCache: SeenCache;

  const SERVER_ID = "server-test-uuid";
  const USER_ID = "user-test-uuid";

  // Generate one crypto instance to share across tests (key gen is slow).
  // We need a real ServerCrypto so sign() produces valid signatures.
  beforeEach(async () => {
    crypto = await ServerCrypto.create();
    meshManager = makeFakeMeshManager();
    seenCache = new SeenCache();
    pm = new PresenceManager(SERVER_ID, crypto, meshManager as any, seenCache);
  });

  describe("advertise()", () => {
    it("adds the user to userLocations", async () => {
      await pm.advertise(USER_ID, SERVER_ID, {
        username: "alice",
        sig_pubkey: "fake-sig-key",
        enc_pubkey: "fake-enc-key",
      });

      expect(pm.getServerForUser(USER_ID)).toBe(SERVER_ID);
    });

    it("broadcasts USER_ADVERTISE to mesh peers", async () => {
      await pm.advertise(USER_ID, SERVER_ID, {
        username: "alice",
        sig_pubkey: "fake-sig-key",
        enc_pubkey: "fake-enc-key",
      });

      expect(meshManager.broadcast).toHaveBeenCalledOnce();

      const [broadcastEnvelope] = meshManager.broadcast.mock.calls[0] as [Envelope];
      expect(broadcastEnvelope.type).toBe(ProtocolMessageType.USER_ADVERTISE);
      expect(broadcastEnvelope.from).toBe(SERVER_ID);
      expect(broadcastEnvelope.to).toBe("*");
    });

    it("includes username and public keys in the broadcast payload", async () => {
      await pm.advertise(USER_ID, SERVER_ID, {
        username: "alice",
        sig_pubkey: "alice-sig-key",
        enc_pubkey: "alice-enc-key",
      });

      const [env] = meshManager.broadcast.mock.calls[0] as [Envelope];
      expect(env.payload.user_id).toBe(USER_ID);
      expect((env.payload.meta as any).username).toBe("alice");
    });

    it("includes a transport signature on the envelope", async () => {
      await pm.advertise(USER_ID, SERVER_ID, {
        username: "alice",
        sig_pubkey: "k",
        enc_pubkey: "k",
      });

      const [env] = meshManager.broadcast.mock.calls[0] as [Envelope];
      expect(env.sig).toBeDefined();
      expect(typeof env.sig).toBe("string");
      expect(env.sig!.length).toBeGreaterThan(0);
    });
  });

  describe("remove()", () => {
    beforeEach(async () => {
      await pm.advertise(USER_ID, SERVER_ID, {
        username: "alice",
        sig_pubkey: "k",
        enc_pubkey: "k",
      });
      meshManager.broadcast.mockClear();
    });

    it("removes the user from userLocations", async () => {
      await pm.remove(USER_ID, SERVER_ID);
      expect(pm.getServerForUser(USER_ID)).toBeUndefined();
    });

    it("broadcasts USER_REMOVE to mesh peers", async () => {
      await pm.remove(USER_ID, SERVER_ID);

      expect(meshManager.broadcast).toHaveBeenCalledOnce();
      const [env] = meshManager.broadcast.mock.calls[0] as [Envelope];
      expect(env.type).toBe(ProtocolMessageType.USER_REMOVE);
    });

    it("does not remove if the server id does not match", async () => {
      // Another server could have re-advertised the user (stale remove guard)
      await pm.remove(USER_ID, "wrong-server-id");
      expect(pm.getServerForUser(USER_ID)).toBe(SERVER_ID);
      expect(meshManager.broadcast).not.toHaveBeenCalled();
    });
  });

  describe("handleAdvertise() — inbound gossip", () => {
    it("updates userLocations when a valid envelope arrives", async () => {
      const envelope: Envelope = {
        type: ProtocolMessageType.USER_ADVERTISE,
        from: "other-server",
        to: "*",
        ts: Date.now(),
        payload: {
          user_id: "bob-uuid",
          server_id: "other-server",
          meta: { username: "bob", sig_pubkey: "bk", enc_pubkey: "bk" },
        },
      };

      const fakeLink = { remoteId: "other-server" } as any;
      await pm.handleAdvertise(envelope, fakeLink);

      expect(pm.getServerForUser("bob-uuid")).toBe("other-server");
    });

    it("drops duplicate envelopes (SeenCache)", async () => {
      const envelope: Envelope = {
        type: ProtocolMessageType.USER_ADVERTISE,
        from: "other-server",
        to: "*",
        ts: 12345,
        payload: {
          user_id: "bob-uuid",
          server_id: "other-server",
          meta: {},
        },
      };

      const fakeLink = { remoteId: "other-server" } as any;
      await pm.handleAdvertise(envelope, fakeLink);
      await pm.handleAdvertise(envelope, fakeLink); // duplicate

      // broadcast should only be called once
      expect(meshManager.broadcast).toHaveBeenCalledOnce();
    });
  });

  describe("handleRemove() — inbound gossip", () => {
    it("removes user from userLocations", async () => {
      // First advertise from another server
      const advEnv: Envelope = {
        type: ProtocolMessageType.USER_ADVERTISE,
        from: "server-b",
        to: "*",
        ts: 1000,
        payload: {
          user_id: "carol-uuid",
          server_id: "server-b",
          meta: { username: "carol", sig_pubkey: "ck", enc_pubkey: "ck" },
        },
      };
      await pm.handleAdvertise(advEnv, { remoteId: "server-b" } as any);
      expect(pm.getServerForUser("carol-uuid")).toBe("server-b");

      // Then receive the removal
      const remEnv: Envelope = {
        type: ProtocolMessageType.USER_REMOVE,
        from: "server-b",
        to: "*",
        ts: 2000,
        payload: { user_id: "carol-uuid", server_id: "server-b" },
      };
      await pm.handleRemove(remEnv, { remoteId: "server-b" } as any);
      expect(pm.getServerForUser("carol-uuid")).toBeUndefined();
    });
  });

  describe("getDirectory()", () => {
    it("returns all online users with their metadata", async () => {
      await pm.advertise("user-1", SERVER_ID, { username: "alice", sig_pubkey: "ak", enc_pubkey: "ak" });
      await pm.advertise("user-2", SERVER_ID, { username: "bob", sig_pubkey: "bk", enc_pubkey: "bk" });

      const dir = pm.getDirectory();
      expect(dir).toHaveLength(2);
      const usernames = dir.map((u) => u.username).sort();
      expect(usernames).toEqual(["alice", "bob"]);
    });
  });
}, 30000); // generous timeout for ServerCrypto.create() in beforeEach
