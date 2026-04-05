import {
  ProtocolMessageType,
  type Envelope,
  type UserHelloPayload,
  type UserDeliverPayload,
} from "@mesh-chat/common";
import type { ClientLink } from "../net/ClientLink.js";
import type { PresenceManager } from "./PresenceManager.js";
import type { UserRepository } from "../auth/UserRepository.js";

/**
 * Manages the `localUsers` in-memory table.
 *
 * `localUsers` maps userId → ClientLink for every user currently
 * connected to THIS server via Socket.io. It does NOT know about
 * users on other servers (that's PresenceManager's userLocations table).
 *
 * Responsibilities:
 *   1. Handle USER_HELLO: register the user and trigger presence gossip
 *   2. Handle disconnect: unregister the user and trigger gossip removal
 *   3. Deliver USER_DELIVER envelopes to local users
 *   4. Provide the full network user directory to newly logged-in clients
 *
 * OOP: LocalUserManager uses PresenceManager (injected) to gossip
 * presence changes. Neither owns the other — they collaborate.
 */
export class LocalUserManager {
  /** userId → ClientLink for all users connected to this server */
  private localUsers: Map<string, ClientLink> = new Map();

  private serverId: string;
  private presenceManager: PresenceManager;
  private userRepo: UserRepository;

  constructor(
    serverId: string,
    presenceManager: PresenceManager,
    userRepo: UserRepository,
  ) {
    this.serverId = serverId;
    this.presenceManager = presenceManager;
    this.userRepo = userRepo;
  }

  // ── USER_HELLO ────────────────────────────────────────────────────────────

  /**
   * Handle a USER_HELLO envelope from a newly connected client.
   *
   * The spec says USER_HELLO is the client's first message after login.
   * It carries the client's public keys and announces their presence.
   *
   * Steps:
   *   1. Validate the userId exists in our DB (they must be registered)
   *   2. Register userId → link in localUsers
   *   3. Wire the link's close handler to trigger USER_REMOVE on disconnect
   *   4. Tell PresenceManager to gossip USER_ADVERTISE to the network
   *   5. Send the full user directory back to this client
   *
   * @param envelope - The USER_HELLO envelope
   * @param link     - The client's Socket.io connection
   */
  async handleHello(envelope: Envelope, link: ClientLink): Promise<void> {
    const userId = envelope.from;
    const payload = envelope.payload as UserHelloPayload;

    // Validate the user exists in this server's database.
    // A user must have registered on this server to connect to it.
    const userRecord = this.userRepo.findById(userId);
    if (!userRecord) {
      // Send an error and close — unknown user
      link.send({
        type: ProtocolMessageType.ERROR,
        from: this.serverId,
        to: userId,
        ts: Date.now(),
        payload: { code: "USER_NOT_FOUND", message: "User not registered on this server" },
      });
      link.close();
      return;
    }

    // Register and track the connection
    this.localUsers.set(userId, link);

    // When the client disconnects (intentionally or due to network error),
    // clean up and gossip removal to the network.
    link.onClose(() => {
      this.handleDisconnect(userId);
    });

    // Advertise to the whole network that this user is now online
    await this.presenceManager.advertise(userId, this.serverId, {
      username: userRecord.username,
      sig_pubkey: payload.sig_pubkey,
      enc_pubkey: payload.enc_pubkey,
    });

    // Send the full user directory to this client so they can see
    // who is online across the entire network.
    this.sendDirectory(userId, link);

    console.log(`[LocalUserManager] User ${userRecord.username} (${userId}) connected`);
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  /**
   * Called when a user's Socket.io connection closes.
   * Removes them from localUsers and gossips USER_REMOVE to the network.
   */
  private async handleDisconnect(userId: string): Promise<void> {
    if (!this.localUsers.has(userId)) return;

    this.localUsers.delete(userId);
    await this.presenceManager.remove(userId, this.serverId);

    console.log(`[LocalUserManager] User ${userId} disconnected`);
  }

  // ── USER_DELIVER ──────────────────────────────────────────────────────────

  /**
   * Deliver a USER_DELIVER envelope to a locally connected user.
   *
   * @returns true if the user was found and the message was sent
   */
  deliverToUser(userId: string, envelope: Envelope): boolean {
    const link = this.localUsers.get(userId);
    if (!link) return false;
    link.send(envelope);
    return true;
  }

  // ── Directory ─────────────────────────────────────────────────────────────

  /**
   * Send the full network user directory to a newly connected client.
   *
   * The spec says: "the client gets the usernames, UUIDs, and public keys
   * of all users on the network." We build this from the userLocations
   * table (maintained by PresenceManager) and our local user DB.
   *
   * We send it as a USER_DELIVER-style envelope with a special type.
   * The client will populate its PeerStore from this.
   */
  private sendDirectory(userId: string, link: ClientLink): void {
    const directory = this.presenceManager.getDirectory();

    link.send({
      type: ProtocolMessageType.USER_ADVERTISE,
      from: this.serverId,
      to: userId,
      ts: Date.now(),
      // We reuse USER_ADVERTISE with a special "bulk" flag so the client
      // knows this is the full directory snapshot, not a single user event.
      payload: {
        bulk: true,
        users: directory,
      },
    });
  }

  // ── Relay presence to clients ──────────────────────────────────────────────

  /**
   * Forward a USER_ADVERTISE or USER_REMOVE envelope to all locally
   * connected clients so their user lists update in real time.
   *
   * Called by MeshServer wiring whenever PresenceManager processes an
   * inbound presence event (both local and from peer servers).
   */
  broadcastToLocalClients(envelope: Envelope): void {
    for (const link of this.localUsers.values()) {
      link.send(envelope);
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Check if a user is connected locally. */
  hasUser(userId: string): boolean {
    return this.localUsers.has(userId);
  }

  /** Returns the count of locally connected users. */
  getLocalUserCount(): number {
    return this.localUsers.size;
  }
}
