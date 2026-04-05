import {
  ProtocolMessageType,
  type Envelope,
  type MsgDirectPayload,
  type UserDeliverPayload,
  type ServerDeliverPayload,
} from "@mesh-chat/common";
import { ServerCrypto } from "../crypto/ServerCrypto.js";
import type { PresenceManager } from "../presence/PresenceManager.js";
import type { LocalUserManager } from "../presence/LocalUserManager.js";
import type { MeshManager } from "../mesh/MeshManager.js";
import type { UserRepository } from "../auth/UserRepository.js";
import type { Link } from "../net/Link.js";
import type { ServerLink } from "../net/ServerLink.js";

/**
 * Routes encrypted direct messages to their destination.
 *
 * Handles two inbound message types:
 *
 *   MSG_DIRECT  — from a local client wanting to send a DM.
 *                 The server inspects userLocations to decide whether
 *                 to deliver locally or forward to another server.
 *
 *   SERVER_DELIVER — from a peer server forwarding a DM to one of our
 *                    local users. We verify the transport signature and
 *                    re-wrap as USER_DELIVER for the recipient client.
 *
 * Critical invariant: the server NEVER decrypts. It only moves
 * the ciphertext between envelopes and signs/verifies transport
 * signatures for routing integrity.
 */
export class MessageRouter {
  private serverId: string;
  private crypto: ServerCrypto;
  private presenceManager: PresenceManager;
  private localUserManager: LocalUserManager;
  private meshManager: MeshManager;
  private userRepo: UserRepository;

  constructor(
    serverId: string,
    crypto: ServerCrypto,
    presenceManager: PresenceManager,
    localUserManager: LocalUserManager,
    meshManager: MeshManager,
    userRepo: UserRepository,
  ) {
    this.serverId = serverId;
    this.crypto = crypto;
    this.presenceManager = presenceManager;
    this.localUserManager = localUserManager;
    this.meshManager = meshManager;
    this.userRepo = userRepo;
  }

  // ── MSG_DIRECT ────────────────────────────────────────────────────────────

  /**
   * Handle MSG_DIRECT from a local client (Alice wants to send to Bob).
   *
   * Routing decision:
   *   - If recipient is local (on this server) → build USER_DELIVER and push directly
   *   - If recipient is on another server      → build SERVER_DELIVER and forward
   *   - If recipient is unknown                → send ERROR back to sender
   *
   * @param envelope - The MSG_DIRECT envelope from the client
   * @param senderLink - The sender's ClientLink (to send errors back to)
   */
  async handleDirect(envelope: Envelope, senderLink: Link): Promise<void> {
    const recipientId = envelope.to;
    const senderId = envelope.from;
    const payload = envelope.payload as MsgDirectPayload;

    // Look up the sender's username for inclusion in delivery envelopes
    const senderRecord = this.userRepo.findById(senderId);
    const senderUsername = senderRecord?.username ?? senderId;

    // Where is the recipient?
    const recipientServerId = this.presenceManager.getServerForUser(recipientId);

    if (!recipientServerId) {
      // Recipient not found on the network — send ERROR back to sender
      senderLink.send({
        type: ProtocolMessageType.ERROR,
        from: this.serverId,
        to: senderId,
        ts: Date.now(),
        payload: {
          code: "USER_NOT_FOUND",
          message: `User ${recipientId} is not online`,
        },
      });
      return;
    }

    if (recipientServerId === this.serverId) {
      // ── Local delivery ──────────────────────────────────────────────────
      // Recipient is on this server. Build USER_DELIVER and push directly.
      await this.deliverLocally(recipientId, envelope.ts, payload, senderUsername);
    } else {
      // ── Remote delivery ─────────────────────────────────────────────────
      // Recipient is on another server. Forward as SERVER_DELIVER.
      await this.forwardToServer(recipientId, recipientServerId, envelope.ts, payload, senderUsername);
    }
  }

  // ── SERVER_DELIVER ────────────────────────────────────────────────────────

  /**
   * Handle SERVER_DELIVER arriving from a peer server.
   *
   * Steps per spec:
   *   1. Verify the transport signature (sig) using the sending server's
   *      public key — this proves the message came from a trusted peer.
   *   2. Re-wrap the payload as USER_DELIVER signed with our own key.
   *   3. Push USER_DELIVER to the recipient's local ClientLink.
   *
   * @param envelope  - The SERVER_DELIVER envelope
   * @param fromLink  - The ServerLink the message arrived on
   */
  async handleServerDeliver(envelope: Envelope, fromLink: ServerLink): Promise<void> {
    const payload = envelope.payload as ServerDeliverPayload;

    // 1. Verify transport signature
    const senderPubKey = this.meshManager.getPubKey(envelope.from);
    if (senderPubKey && envelope.sig) {
      const canonical = ServerCrypto.canonicalizePayload(payload);
      if (!await ServerCrypto.verify(canonical, envelope.sig, senderPubKey)) {
        console.warn(`[MessageRouter] Bad transport sig on SERVER_DELIVER from ${envelope.from}`);
        return;
      }
    }

    // 2. Build USER_DELIVER and sign it with our server's private key
    await this.deliverLocally(
      payload.user_id,
      envelope.ts,
      {
        ciphertext: payload.ciphertext,
        sender_sig_pub: payload.sender_pub,
        content_sig: payload.content_sig,
      },
      payload.sender,
    );
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Build a USER_DELIVER envelope and push it to a local user's ClientLink.
   *
   * The server signs the USER_DELIVER payload for transport integrity —
   * the recipient client will know this came from a trusted server.
   */
  private async deliverLocally(
    recipientId: string,
    originalTs: number,
    msgPayload: Pick<MsgDirectPayload, "ciphertext" | "sender_sig_pub" | "content_sig">,
    senderUsername: string,
  ): Promise<void> {
    const deliverPayload: UserDeliverPayload = {
      ciphertext: msgPayload.ciphertext,
      sender: senderUsername,
      sender_sig_pub: msgPayload.sender_sig_pub,
      content_sig: msgPayload.content_sig,
    };

    const deliverEnvelope: Envelope = {
      type: ProtocolMessageType.USER_DELIVER,
      from: this.serverId,
      to: recipientId,
      ts: originalTs,
      payload: deliverPayload,
      sig: await this.crypto.sign(
        ServerCrypto.canonicalizePayload(deliverPayload),
      ),
    };

    const delivered = this.localUserManager.deliverToUser(recipientId, deliverEnvelope);
    if (!delivered) {
      console.warn(`[MessageRouter] Failed to deliver to local user ${recipientId} — not in localUsers`);
    }
  }

  /**
   * Build a SERVER_DELIVER envelope signed with our key and send it to
   * the peer server that hosts the recipient.
   */
  private async forwardToServer(
    recipientId: string,
    recipientServerId: string,
    originalTs: number,
    msgPayload: MsgDirectPayload,
    senderUsername: string,
  ): Promise<void> {
    const serverDeliverPayload: ServerDeliverPayload = {
      user_id: recipientId,
      ciphertext: msgPayload.ciphertext,
      sender: senderUsername,
      sender_pub: msgPayload.sender_sig_pub,
      content_sig: msgPayload.content_sig,
    };

    const forwardEnvelope: Envelope = {
      type: ProtocolMessageType.SERVER_DELIVER,
      from: this.serverId,
      to: recipientServerId,
      ts: Date.now(),
      payload: serverDeliverPayload,
      sig: await this.crypto.sign(
        ServerCrypto.canonicalizePayload(serverDeliverPayload),
      ),
    };

    this.meshManager.broadcast(forwardEnvelope, undefined);
  }
}
