import { describe, it, expect, beforeAll } from "vitest";
import { ProtocolMessageType, MAX_PLAINTEXT_BYTES, type Envelope } from "@mesh-chat/common";
import { ClientCrypto } from "../../src/crypto/ClientCrypto.js";
import { MessageService } from "../../src/net/MessageService.js";

/**
 * MessageService tests.
 *
 * We run real RSA-4096 keygen (slow) but reuse keys across tests via beforeAll.
 * Each test that calls buildDirectMessage + parseDelivery performs:
 *   - 1 RSA-OAEP encrypt (fast)
 *   - 1 RSA-PSS sign (fast)
 *   - 1 RSA-OAEP decrypt (fast)
 *   - 1 RSA-PSS verify (fast)
 * The keygen cost (once) dominates; everything else is milliseconds.
 */
describe("MessageService", () => {
  // Alice is the sender; Bob is the recipient
  let aliceCrypto: ClientCrypto;
  let bobCrypto: ClientCrypto;
  let alicePubKeys: { enc_pubkey: string; sig_pubkey: string };
  let bobPubKeys: { enc_pubkey: string; sig_pubkey: string };

  const ALICE_ID = "alice-uuid";
  const BOB_ID = "bob-uuid";
  const SERVER_ID = "server-uuid";

  beforeAll(async () => {
    aliceCrypto = new ClientCrypto();
    bobCrypto = new ClientCrypto();
    await aliceCrypto.generateKeyPairs();
    await bobCrypto.generateKeyPairs();
    alicePubKeys = await aliceCrypto.exportPublicKeys();
    bobPubKeys = await bobCrypto.exportPublicKeys();
  }, 30000);

  // ── buildDirectMessage ────────────────────────────────────────────────────

  describe("buildDirectMessage()", () => {
    it("produces an Envelope with type MSG_DIRECT", async () => {
      const envelope = await MessageService.buildDirectMessage(
        ALICE_ID, BOB_ID,
        bobPubKeys.enc_pubkey,
        alicePubKeys.sig_pubkey,
        "Hello Bob",
        aliceCrypto,
      );

      expect(envelope.type).toBe(ProtocolMessageType.MSG_DIRECT);
    });

    it("sets from/to correctly", async () => {
      const envelope = await MessageService.buildDirectMessage(
        ALICE_ID, BOB_ID,
        bobPubKeys.enc_pubkey,
        alicePubKeys.sig_pubkey,
        "Hi",
        aliceCrypto,
      );

      expect(envelope.from).toBe(ALICE_ID);
      expect(envelope.to).toBe(BOB_ID);
    });

    it("payload has ciphertext, sender_sig_pub, and content_sig", async () => {
      const envelope = await MessageService.buildDirectMessage(
        ALICE_ID, BOB_ID,
        bobPubKeys.enc_pubkey,
        alicePubKeys.sig_pubkey,
        "test",
        aliceCrypto,
      );

      expect(typeof envelope.payload.ciphertext).toBe("string");
      expect(typeof envelope.payload.sender_sig_pub).toBe("string");
      expect(typeof envelope.payload.content_sig).toBe("string");
      // sender_sig_pub should be our signing public key
      expect(envelope.payload.sender_sig_pub).toBe(alicePubKeys.sig_pubkey);
    });

    it("throws when plaintext exceeds 446 bytes", async () => {
      const tooLong = "A".repeat(MAX_PLAINTEXT_BYTES + 1);

      await expect(
        MessageService.buildDirectMessage(
          ALICE_ID, BOB_ID,
          bobPubKeys.enc_pubkey,
          alicePubKeys.sig_pubkey,
          tooLong,
          aliceCrypto,
        ),
      ).rejects.toThrow("too long");
    });

    it("accepts exactly 446 bytes", async () => {
      const maxMessage = "A".repeat(MAX_PLAINTEXT_BYTES);

      await expect(
        MessageService.buildDirectMessage(
          ALICE_ID, BOB_ID,
          bobPubKeys.enc_pubkey,
          alicePubKeys.sig_pubkey,
          maxMessage,
          aliceCrypto,
        ),
      ).resolves.toBeDefined();
    });
  });

  // ── parseDelivery ─────────────────────────────────────────────────────────

  describe("parseDelivery()", () => {
    /**
     * Helper: build the MSG_DIRECT Alice would send, then simulate what
     * the server produces as USER_DELIVER (re-wrap the payload, add sender name).
     */
    async function buildUserDeliver(plaintext: string): Promise<Envelope> {
      const msgDirect = await MessageService.buildDirectMessage(
        ALICE_ID, BOB_ID,
        bobPubKeys.enc_pubkey,
        alicePubKeys.sig_pubkey,
        plaintext,
        aliceCrypto,
      );

      // The server takes the MSG_DIRECT payload and re-wraps it as USER_DELIVER,
      // adding the sender's username from its database.
      return {
        type: ProtocolMessageType.USER_DELIVER,
        from: SERVER_ID,
        to: BOB_ID,
        ts: msgDirect.ts, // server preserves the original ts
        payload: {
          ciphertext: msgDirect.payload.ciphertext,
          sender: "alice",
          sender_sig_pub: msgDirect.payload.sender_sig_pub,
          content_sig: msgDirect.payload.content_sig,
        },
      };
    }

    it("decrypts the ciphertext back to the original plaintext", async () => {
      const deliver = await buildUserDeliver("Hello from Alice!");
      const parsed = await MessageService.parseDelivery(deliver, bobCrypto);

      expect(parsed.plaintext).toBe("Hello from Alice!");
    });

    it("returns the sender's display name", async () => {
      const deliver = await buildUserDeliver("Hi");
      const parsed = await MessageService.parseDelivery(deliver, bobCrypto);

      expect(parsed.sender).toBe("alice");
    });

    it("sets verified=true when the content_sig is valid", async () => {
      const deliver = await buildUserDeliver("Signed message");
      const parsed = await MessageService.parseDelivery(deliver, bobCrypto);

      expect(parsed.verified).toBe(true);
    });

    it("sets verified=false when the content_sig is tampered", async () => {
      const deliver = await buildUserDeliver("Original");

      // Tamper with the content_sig by replacing it with a garbage value
      const tampered: Envelope = {
        ...deliver,
        payload: {
          ...deliver.payload,
          content_sig: "dGFtcGVyZWQ", // "tampered" in base64url
        },
      };

      const parsed = await MessageService.parseDelivery(tampered, bobCrypto);
      expect(parsed.verified).toBe(false);
    });

    it("preserves the original ts", async () => {
      const deliver = await buildUserDeliver("timestamp test");
      const parsed = await MessageService.parseDelivery(deliver, bobCrypto);

      expect(parsed.ts).toBe(deliver.ts);
    });

    it("throws if decryption fails (wrong private key)", async () => {
      const deliver = await buildUserDeliver("Secret");

      // Try to decrypt with Alice's crypto instead of Bob's — wrong private key
      await expect(
        MessageService.parseDelivery(deliver, aliceCrypto),
      ).rejects.toThrow();
    });
  });
}, 60000);
