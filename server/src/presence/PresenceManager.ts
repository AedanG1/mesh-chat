import {
  ProtocolMessageType,
  type Envelope,
  type UserAdvertisePayload,
  type UserRemovePayload,
} from "@mesh-chat/common";
import { ServerCrypto } from "../crypto/ServerCrypto.js";
import type { MeshManager } from "../mesh/MeshManager.js";
import type { SeenCache } from "../mesh/SeenCache.js";
import type { ServerLink } from "../net/ServerLink.js";

/**
 * Directory entry for a single online user.
 * Shared in the bulk directory sent to newly connected clients.
 */
export interface UserDirectoryEntry {
  userId: string;
  serverId: string;
  username: string;
  sig_pubkey: string;
  enc_pubkey: string;
}

/**
 * Manages user presence across the entire mesh network.
 *
 * Owns the `userLocations` in-memory table:
 *   userLocations: Map<userId, serverId>
 *
 * This maps every known online user to the server they are connected to.
 * It is updated by inbound USER_ADVERTISE and USER_REMOVE gossip messages
 * from other servers, and by local events from LocalUserManager.
 *
 * Two roles:
 *   OUTBOUND: create and broadcast USER_ADVERTISE / USER_REMOVE when
 *             a local user connects or disconnects
 *   INBOUND:  handle USER_ADVERTISE / USER_REMOVE received from peer
 *             servers — verify sig, update table, forward gossip
 */
export class PresenceManager {
  /** userId → serverId for all known online users (local + remote). */
  private userLocations: Map<string, string> = new Map();

  /**
   * Extended metadata for each online user (username, public keys).
   * Populated from USER_ADVERTISE payloads.
   */
  private userMeta: Map<string, { username: string; sig_pubkey: string; enc_pubkey: string }> =
    new Map();

  private serverId: string;
  private crypto: ServerCrypto;
  private meshManager: MeshManager;
  private seenCache: SeenCache;

  constructor(
    serverId: string,
    crypto: ServerCrypto,
    meshManager: MeshManager,
    seenCache: SeenCache,
  ) {
    this.serverId = serverId;
    this.crypto = crypto;
    this.meshManager = meshManager;
    this.seenCache = seenCache;
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  /**
   * Announce that a local user is now online.
   * Called by LocalUserManager when USER_HELLO is accepted.
   *
   * Updates our local table first, then broadcasts USER_ADVERTISE
   * to all peer servers.
   *
   * @param userId   - The user's UUID
   * @param serverId - Our own server UUID (where this user is connected)
   * @param meta     - Username and public keys to share with the network
   */
  advertise(
    userId: string,
    serverId: string,
    meta: { username: string; sig_pubkey: string; enc_pubkey: string },
  ): void {
    // Update our own table immediately (don't wait for gossip to loop back)
    this.userLocations.set(userId, serverId);
    this.userMeta.set(userId, meta);

    const payload: UserAdvertisePayload = {
      user_id: userId,
      server_id: serverId,
      meta: {
        username: meta.username,
        sig_pubkey: meta.sig_pubkey,
        enc_pubkey: meta.enc_pubkey,
      },
    };

    const envelope: Envelope = {
      type: ProtocolMessageType.USER_ADVERTISE,
      from: this.serverId,
      to: "*",
      ts: Date.now(),
      payload,
      sig: this.crypto.sign(
        ServerCrypto.canonicalizePayload(payload),
      ),
    };

    // Mark as seen before broadcasting so we don't re-process our own gossip
    this.seenCache.markSeen(envelope);
    this.meshManager.broadcast(envelope);
  }

  /**
   * Announce that a local user has gone offline.
   * Called by LocalUserManager on disconnect.
   */
  remove(userId: string, serverId: string): void {
    // Only remove if this server still owns the user.
    // (Another server may have already re-advertised them.)
    if (this.userLocations.get(userId) !== serverId) return;

    this.userLocations.delete(userId);
    this.userMeta.delete(userId);

    const payload: UserRemovePayload = {
      user_id: userId,
      server_id: serverId,
    };

    const envelope: Envelope = {
      type: ProtocolMessageType.USER_REMOVE,
      from: this.serverId,
      to: "*",
      ts: Date.now(),
      payload,
      sig: this.crypto.sign(
        ServerCrypto.canonicalizePayload(payload),
      ),
    };

    this.seenCache.markSeen(envelope);
    this.meshManager.broadcast(envelope);
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  /**
   * Handle a USER_ADVERTISE received from another server.
   *
   * Steps per spec:
   *   1. SeenCache dedup check
   *   2. Verify transport signature using the sender server's public key
   *   3. Update userLocations[userId] = serverId
   *   4. Forward to all other peer servers (gossip)
   */
  handleAdvertise(envelope: Envelope, fromLink: ServerLink): void {
    if (this.seenCache.hasSeen(envelope)) return;
    this.seenCache.markSeen(envelope);

    const payload = envelope.payload as UserAdvertisePayload;

    // Verify transport signature using the sending server's pinned public key
    const senderPubKey = this.meshManager.getPubKey(envelope.from);
    if (senderPubKey && envelope.sig) {
      const canonical = ServerCrypto.canonicalizePayload(payload);
      if (!ServerCrypto.verify(canonical, envelope.sig, senderPubKey)) {
        console.warn(`[PresenceManager] Bad sig on USER_ADVERTISE from ${envelope.from}`);
        return;
      }
    }

    // Update the table: this user is now on the specified server
    this.userLocations.set(payload.user_id, payload.server_id);

    // Store their metadata (username + public keys) from the meta field
    const meta = payload.meta as { username?: string; sig_pubkey?: string; enc_pubkey?: string };
    if (meta.username && meta.sig_pubkey && meta.enc_pubkey) {
      this.userMeta.set(payload.user_id, {
        username: meta.username,
        sig_pubkey: meta.sig_pubkey,
        enc_pubkey: meta.enc_pubkey,
      });
    }

    // Forward to all other servers (gossip propagation)
    this.meshManager.broadcast(envelope, fromLink.remoteId);
  }

  /**
   * Handle a USER_REMOVE received from another server.
   *
   * Steps per spec:
   *   1. SeenCache dedup check
   *   2. Verify transport signature
   *   3. Only remove if userLocations[userId] still points to that server
   *   4. Forward gossip
   */
  handleRemove(envelope: Envelope, fromLink: ServerLink): void {
    if (this.seenCache.hasSeen(envelope)) return;
    this.seenCache.markSeen(envelope);

    const payload = envelope.payload as UserRemovePayload;

    const senderPubKey = this.meshManager.getPubKey(envelope.from);
    if (senderPubKey && envelope.sig) {
      const canonical = ServerCrypto.canonicalizePayload(payload);
      if (!ServerCrypto.verify(canonical, envelope.sig, senderPubKey)) {
        console.warn(`[PresenceManager] Bad sig on USER_REMOVE from ${envelope.from}`);
        return;
      }
    }

    // Spec: only delete if the current mapping still points to the claiming server.
    // This prevents a stale USER_REMOVE from overriding a more recent USER_ADVERTISE.
    if (this.userLocations.get(payload.user_id) === payload.server_id) {
      this.userLocations.delete(payload.user_id);
      this.userMeta.delete(payload.user_id);
    }

    this.meshManager.broadcast(envelope, fromLink.remoteId);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /**
   * Look up which server a user is on.
   * Returns undefined if the user is not online.
   */
  getServerForUser(userId: string): string | undefined {
    return this.userLocations.get(userId);
  }

  /**
   * Returns the full directory of online users for the bulk snapshot
   * sent to newly connecting clients.
   */
  getDirectory(): UserDirectoryEntry[] {
    const entries: UserDirectoryEntry[] = [];
    for (const [userId, serverId] of this.userLocations) {
      const meta = this.userMeta.get(userId);
      if (meta) {
        entries.push({ userId, serverId, ...meta });
      }
    }
    return entries;
  }

  /** Returns the current userLocations as a plain object (for SERVER_WELCOME). */
  getUserLocationsSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [userId, serverId] of this.userLocations) {
      out[userId] = serverId;
    }
    return out;
  }

  getOnlineUserCount(): number {
    return this.userLocations.size;
  }
}
