import { ProtocolMessageType, type Envelope, type UserAdvertisePayload, type UserRemovePayload } from "@mesh-chat/common";

/**
 * Represents a single online user on the network.
 * Built from USER_ADVERTISE payloads and the bulk directory snapshot.
 */
export interface Peer {
  userId: string;
  username: string;
  sig_pubkey: string;   // base64url RSASSA-PSS public key (verify signatures)
  enc_pubkey: string;   // base64url RSA-OAEP public key (encrypt messages to them)
  serverId: string;     // which server they're connected to
}

/**
 * Tracks all online users across the mesh network.
 *
 * Populated from two sources:
 *   1. Bulk directory — sent by the server right after USER_HELLO. Contains
 *      every user that was online at connect time.
 *   2. Individual USER_ADVERTISE / USER_REMOVE envelopes — relayed by the
 *      server in real time as users join or leave the network.
 *
 * The store is a plain Map keyed by userId. React hooks observe changes
 * via a simple onChange callback (set by the hook).
 *
 * OOP Pattern: Observable Store — holds state and notifies a single
 * listener (the React hook) when the state changes.
 */
export class PeerStore {
  private peers: Map<string, Peer> = new Map();

  /** Called whenever the peer list changes. Set by the React hook. */
  onChange?: () => void;

  /**
   * Handle the bulk directory snapshot sent on initial connect.
   * Replaces the entire peer map.
   *
   * The server sends this as a USER_ADVERTISE envelope with
   * payload.bulk === true and payload.users as an array.
   */
  loadDirectory(users: Array<{ userId: string; serverId: string; username: string; sig_pubkey: string; enc_pubkey: string }>): void {
    this.peers.clear();
    for (const user of users) {
      this.peers.set(user.userId, {
        userId: user.userId,
        username: user.username,
        sig_pubkey: user.sig_pubkey,
        enc_pubkey: user.enc_pubkey,
        serverId: user.serverId,
      });
    }
    this.onChange?.();
  }

  /**
   * Process an inbound envelope that may be a presence event.
   * Called by the socket hook for every envelope received.
   *
   * Handles:
   *   - USER_ADVERTISE (bulk=true → loadDirectory, single → add peer)
   *   - USER_REMOVE → remove peer
   *
   * Returns true if the envelope was a presence event (consumed).
   */
  handleEnvelope(envelope: Envelope): boolean {
    if (envelope.type === ProtocolMessageType.USER_ADVERTISE) {
      // Bulk directory (sent once on connect)
      if (envelope.payload.bulk === true && Array.isArray(envelope.payload.users)) {
        this.loadDirectory(envelope.payload.users as Peer[]);
        return true;
      }

      // Single user came online
      const payload = envelope.payload as UserAdvertisePayload;
      const meta = payload.meta as { username?: string; sig_pubkey?: string; enc_pubkey?: string };
      if (meta.username && meta.sig_pubkey && meta.enc_pubkey) {
        this.peers.set(payload.user_id, {
          userId: payload.user_id,
          username: meta.username,
          sig_pubkey: meta.sig_pubkey,
          enc_pubkey: meta.enc_pubkey,
          serverId: payload.server_id,
        });
        this.onChange?.();
      }
      return true;
    }

    if (envelope.type === ProtocolMessageType.USER_REMOVE) {
      const payload = envelope.payload as UserRemovePayload;
      if (this.peers.has(payload.user_id)) {
        this.peers.delete(payload.user_id);
        this.onChange?.();
      }
      return true;
    }

    return false;
  }

  /** Get all online peers as an array. */
  getAll(): Peer[] {
    return [...this.peers.values()];
  }

  /** Look up a peer by userId. */
  get(userId: string): Peer | undefined {
    return this.peers.get(userId);
  }

  /** Clear all peers (e.g. on disconnect or logout). */
  clear(): void {
    this.peers.clear();
    this.onChange?.();
  }

  get size(): number {
    return this.peers.size;
  }
}
