import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";
import { MessageRouter } from "../../src/routing/MessageRouter.js";
import { ServerCrypto } from "../../src/crypto/ServerCrypto.js";

// ── Test doubles ──────────────────────────────────────────────────────────

const SERVER_ID = "server-a";
const SENDER_ID = "user-sender";
const RECIPIENT_LOCAL_ID = "user-local-recipient";
const RECIPIENT_REMOTE_ID = "user-remote-recipient";
const REMOTE_SERVER_ID = "server-b";

function makePresenceManager(recipientServerId: string | undefined) {
  return {
    getServerForUser: vi.fn((userId: string) => {
      if (userId === RECIPIENT_LOCAL_ID) return SERVER_ID;
      if (userId === RECIPIENT_REMOTE_ID) return recipientServerId;
      return undefined;
    }),
  };
}

function makeLocalUserManager() {
  const receivedEnvelopes: Envelope[] = [];
  return {
    deliverToUser: vi.fn((userId: string, envelope: Envelope) => {
      receivedEnvelopes.push(envelope);
      return true; // user found
    }),
    receivedEnvelopes,
  };
}

function makeUserRepo() {
  return {
    findById: vi.fn((userId: string) =>
      userId === SENDER_ID ? { username: "alice", user_id: SENDER_ID } : undefined
    ),
  };
}

function makeMeshManager() {
  const forwardedEnvelopes: Envelope[] = [];
  return {
    broadcast: vi.fn((envelope: Envelope) => forwardedEnvelopes.push(envelope)),
    getPubKey: vi.fn(() => undefined as string | undefined),
    forwardedEnvelopes,
  };
}

function makeSenderLink() {
  const sent: Envelope[] = [];
  return {
    send: vi.fn((e: Envelope) => sent.push(e)),
    sent,
  };
}

function makeMsgDirect(recipientId: string): Envelope {
  return {
    type: ProtocolMessageType.MSG_DIRECT,
    from: SENDER_ID,
    to: recipientId,
    ts: Date.now(),
    payload: {
      ciphertext: "fake-ciphertext-base64url",
      sender_sig_pub: "sender-sig-pub-base64url",
      content_sig: "content-sig-base64url",
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("MessageRouter", () => {
  let crypto: ServerCrypto;

  beforeAll(async () => {
    crypto = await ServerCrypto.create();
  });

  describe("handleDirect — local delivery", () => {
    let router: MessageRouter;
    let localUserManager: ReturnType<typeof makeLocalUserManager>;
    let senderLink: ReturnType<typeof makeSenderLink>;

    beforeEach(() => {
      localUserManager = makeLocalUserManager();
      const presenceManager = makePresenceManager(SERVER_ID);
      router = new MessageRouter(
        SERVER_ID,
        crypto,
        presenceManager as any,
        localUserManager as any,
        makeMeshManager() as any,
        makeUserRepo() as any,
      );
      senderLink = makeSenderLink();
    });

    it("calls deliverToUser with a USER_DELIVER envelope", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_LOCAL_ID), senderLink as any);

      expect(localUserManager.deliverToUser).toHaveBeenCalledOnce();
      const [userId, envelope] = localUserManager.deliverToUser.mock.calls[0] as [string, Envelope];
      expect(userId).toBe(RECIPIENT_LOCAL_ID);
      expect(envelope.type).toBe(ProtocolMessageType.USER_DELIVER);
    });

    it("USER_DELIVER carries the ciphertext unchanged", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_LOCAL_ID), senderLink as any);

      const [, envelope] = localUserManager.deliverToUser.mock.calls[0] as [string, Envelope];
      expect(envelope.payload.ciphertext).toBe("fake-ciphertext-base64url");
      expect(envelope.payload.content_sig).toBe("content-sig-base64url");
    });

    it("USER_DELIVER is addressed to the recipient", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_LOCAL_ID), senderLink as any);

      const [, envelope] = localUserManager.deliverToUser.mock.calls[0] as [string, Envelope];
      expect(envelope.to).toBe(RECIPIENT_LOCAL_ID);
      expect(envelope.from).toBe(SERVER_ID);
    });

    it("USER_DELIVER has a transport signature", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_LOCAL_ID), senderLink as any);

      const [, envelope] = localUserManager.deliverToUser.mock.calls[0] as [string, Envelope];
      expect(typeof envelope.sig).toBe("string");
      expect(envelope.sig!.length).toBeGreaterThan(0);
    });

    it("includes the sender's username in the delivery payload", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_LOCAL_ID), senderLink as any);

      const [, envelope] = localUserManager.deliverToUser.mock.calls[0] as [string, Envelope];
      expect(envelope.payload.sender).toBe("alice");
    });
  });

  describe("handleDirect — remote delivery", () => {
    let router: MessageRouter;
    let meshManager: ReturnType<typeof makeMeshManager>;
    let senderLink: ReturnType<typeof makeSenderLink>;

    beforeEach(() => {
      meshManager = makeMeshManager();
      const presenceManager = makePresenceManager(REMOTE_SERVER_ID);
      router = new MessageRouter(
        SERVER_ID,
        crypto,
        presenceManager as any,
        makeLocalUserManager() as any,
        meshManager as any,
        makeUserRepo() as any,
      );
      senderLink = makeSenderLink();
    });

    it("calls meshManager.broadcast with a SERVER_DELIVER envelope", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_REMOTE_ID), senderLink as any);

      expect(meshManager.broadcast).toHaveBeenCalledOnce();
      const [envelope] = meshManager.broadcast.mock.calls[0] as [Envelope];
      expect(envelope.type).toBe(ProtocolMessageType.SERVER_DELIVER);
    });

    it("SERVER_DELIVER is addressed to the recipient's server", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_REMOTE_ID), senderLink as any);

      const [envelope] = meshManager.broadcast.mock.calls[0] as [Envelope];
      expect(envelope.to).toBe(REMOTE_SERVER_ID);
    });

    it("SERVER_DELIVER carries recipient userId in payload", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_REMOTE_ID), senderLink as any);

      const [envelope] = meshManager.broadcast.mock.calls[0] as [Envelope];
      expect(envelope.payload.user_id).toBe(RECIPIENT_REMOTE_ID);
      expect(envelope.payload.ciphertext).toBe("fake-ciphertext-base64url");
    });

    it("SERVER_DELIVER has a transport signature", () => {
      router.handleDirect(makeMsgDirect(RECIPIENT_REMOTE_ID), senderLink as any);

      const [envelope] = meshManager.broadcast.mock.calls[0] as [Envelope];
      expect(typeof envelope.sig).toBe("string");
      expect(envelope.sig!.length).toBeGreaterThan(0);
    });
  });

  describe("handleDirect — unknown recipient", () => {
    it("sends ERROR back to the sender when user is not online", () => {
      const presenceManager = makePresenceManager(undefined);
      const senderLink = makeSenderLink();
      const router = new MessageRouter(
        SERVER_ID,
        crypto,
        presenceManager as any,
        makeLocalUserManager() as any,
        makeMeshManager() as any,
        makeUserRepo() as any,
      );

      // RECIPIENT_REMOTE_ID with undefined serverId → not found
      const envelope = makeMsgDirect("nonexistent-user-uuid");
      router.handleDirect(envelope, senderLink as any);

      expect(senderLink.send).toHaveBeenCalledOnce();
      const [errorEnvelope] = senderLink.sent;
      expect(errorEnvelope.type).toBe(ProtocolMessageType.ERROR);
      expect(errorEnvelope.payload.code).toBe("USER_NOT_FOUND");
    });
  });

  describe("handleServerDeliver", () => {
    it("delivers USER_DELIVER to the local recipient after verifying sig", () => {
      const localUserManager = makeLocalUserManager();
      const presenceManager = makePresenceManager(SERVER_ID);
      const router = new MessageRouter(
        SERVER_ID,
        crypto,
        presenceManager as any,
        localUserManager as any,
        makeMeshManager() as any,
        makeUserRepo() as any,
      );

      // Build a valid signed SERVER_DELIVER (as if sent by a remote server)
      const serverDeliverPayload = {
        user_id: RECIPIENT_LOCAL_ID,
        ciphertext: "enc-ciphertext",
        sender: "bob",
        sender_pub: "bob-sig-pub",
        content_sig: "bob-content-sig",
      };
      const envelope: Envelope = {
        type: ProtocolMessageType.SERVER_DELIVER,
        from: "server-b",
        to: SERVER_ID,
        ts: Date.now(),
        payload: serverDeliverPayload,
        // No sig — getPubKey returns undefined so verification is skipped
      };

      const fromLink = { remoteId: "server-b" } as any;
      router.handleServerDeliver(envelope, fromLink);

      expect(localUserManager.deliverToUser).toHaveBeenCalledOnce();
      const [userId, delivered] = localUserManager.deliverToUser.mock.calls[0] as [string, Envelope];
      expect(userId).toBe(RECIPIENT_LOCAL_ID);
      expect(delivered.type).toBe(ProtocolMessageType.USER_DELIVER);
      expect(delivered.payload.ciphertext).toBe("enc-ciphertext");
      expect(delivered.payload.sender).toBe("bob");
    });
  });
}, 30000); // generous: ServerCrypto.create() is slow
