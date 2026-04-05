import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import {
  ProtocolMessageType,
  type Envelope,
  type ServerHelloJoinPayload,
  type ServerWelcomePayload,
  type ServerAnnouncePayload,
  type ServerInfo,
  type ServerAddr,
} from "@mesh-chat/common";
import { ServerCrypto } from "../crypto/ServerCrypto.js";
import { ServerLink } from "../net/ServerLink.js";
import { SeenCache } from "./SeenCache.js";

/**
 * Manages the mesh network topology.
 *
 * Owns the two core in-memory tables:
 *   - servers:      Map<serverId, ServerLink>  — active WS connections to peers
 *   - serverAddrs:  Map<serverId, ServerAddr>  — [host, port] for each known peer
 *   - serverPubKeys: Map<serverId, string>     — pinned RSASSA-PSS public keys
 *
 * Three roles baked into one class:
 *   1. JOINING SERVER  — calls joinNetwork(), sends SERVER_HELLO_JOIN, receives
 *                        SERVER_WELCOME with the full network state snapshot
 *   2. INTRODUCER      — calls handleHelloJoin() when a new server connects,
 *                        assigns its UUID, sends back the network snapshot
 *   3. ALL SERVERS     — calls handleAnnounce() when SERVER_ANNOUNCE arrives,
 *                        registers the new peer and forwards the gossip
 */
export class MeshManager {
  /** Active WebSocket connections to other servers. */
  private servers: Map<string, ServerLink> = new Map();

  /** [host, port] for every known server on the network. */
  private serverAddrs: Map<string, ServerAddr> = new Map();

  /** Pinned RSASSA-PSS public keys, keyed by server UUID. */
  private serverPubKeys: Map<string, string> = new Map();

  private crypto: ServerCrypto;
  private seenCache: SeenCache;

  private serverId: string;
  private host: string;
  private port: number;

  /**
   * Wired by MeshServer so it can route messages through ProtocolHandler
   * whenever a new peer connection is established.
   */
  onPeerConnected?: (link: ServerLink) => void;

  /**
   * Optional callback to fetch the current userLocations snapshot
   * for inclusion in SERVER_WELCOME. Wired in by MeshServer in Phase 4.
   */
  getUserLocationsSnapshot?: () => Record<string, string>;

  constructor(
    serverId: string,
    host: string,
    port: number,
    crypto: ServerCrypto,
    seenCache: SeenCache,
  ) {
    this.serverId = serverId;
    this.host = host;
    this.port = port;
    this.crypto = crypto;
    this.seenCache = seenCache;
  }

  // ── Joining the Network ───────────────────────────────────────────────────

  /**
   * Attempt to join the mesh by trying each address in the bootstrap list.
   *
   * On success: receives the full network state, connects to all peers,
   *             and broadcasts SERVER_ANNOUNCE to announce our presence.
   * On failure (all unreachable): starts as the seed node.
   */
  /**
   * Attempt to join the mesh by trying each address in the bootstrap list.
   *
   * @param bootstrapList  - Addresses to try (e.g. ["server1:3001", "server2:3002"])
   * @param maxRetries     - How many times to retry the full list (default 5 for Docker)
   * @param baseDelayMs    - Base delay between retries in ms; actual delay = base * attempt
   */
  async joinNetwork(
    bootstrapList: string[],
    maxRetries: number = 5,
    baseDelayMs: number = 2000,
  ): Promise<void> {
    // Retry the entire bootstrap list up to maxRetries times with increasing delays.
    // This handles Docker startup race conditions where depends_on only waits
    // for the container to start, not for the server app to be listening.
    const MAX_RETRIES = maxRetries;
    const BASE_DELAY_MS = baseDelayMs;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      for (const addr of bootstrapList) {
        const [host, portStr] = addr.split(":");
        const port = parseInt(portStr, 10);

        if (host === this.host && port === this.port) continue;

        const success = await this.tryJoinVia(host, port);
        if (success) {
          await this.broadcastAnnounce();
          return;
        }
      }

      // If this isn't the last attempt, wait before retrying
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * (attempt + 1);
        console.log(
          `[MeshManager] Bootstrap attempt ${attempt + 1}/${MAX_RETRIES} failed. ` +
          `Retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    console.log("[MeshManager] No reachable introducers. Starting as seed node.");
  }

  /**
   * Connect to a single introducer candidate and attempt the handshake.
   * Returns true if SERVER_WELCOME was received successfully.
   */
  private tryJoinVia(introduceHost: string, introducePort: number): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${introduceHost}:${introducePort}/ws`);

      const timeout = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 5000);

      ws.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });

      ws.on("open", () => {
        clearTimeout(timeout);

        // Send SERVER_HELLO_JOIN — sig is optional here (spec allows omitting it
        // before we have each other's public keys).
        const payload: ServerHelloJoinPayload = {
          host: this.host,
          port: this.port,
          sig_pubkey: this.crypto.getPublicKeyB64(),
        };
        ws.send(JSON.stringify({
          type: ProtocolMessageType.SERVER_HELLO_JOIN,
          from: this.serverId,
          to: `${introduceHost}:${introducePort}`,
          ts: Date.now(),
          payload,
        } satisfies Envelope));

        // Wait for exactly one message — must be SERVER_WELCOME
        ws.once("message", (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString()) as Envelope;
            if (msg.type !== ProtocolMessageType.SERVER_WELCOME) {
              ws.terminate();
              resolve(false);
              return;
            }

            const welcome = msg.payload as ServerWelcomePayload;

            // Accept the assigned ID (introducer may have changed it to resolve collisions)
            this.serverId = welcome.assigned_id;

            // Populate in-memory tables from the network snapshot.
            // JSON serializes Maps as plain objects, so we iterate Object.entries.
            for (const [id, info] of Object.entries(welcome.servers)) {
              const serverInfo = info as ServerInfo;
              this.serverAddrs.set(id, [serverInfo.host, serverInfo.port]);
              this.serverPubKeys.set(id, serverInfo.sig_pubkey);
            }

            // Register the introducer link and connect to all other known peers
            const introducerLink = new ServerLink(ws, msg.from);
            this.registerLink(msg.from, introducerLink);

            for (const [peerId, [host, port]] of this.serverAddrs) {
              if (peerId === msg.from) continue;
              if (host === this.host && port === this.port) continue;
              this.connectToPeer(peerId, host, port);
            }

            console.log(
              `[MeshManager] Joined network. ID: ${this.serverId}. ` +
              `Peers: ${this.serverAddrs.size}`,
            );

            resolve(true);
          } catch {
            ws.terminate();
            resolve(false);
          }
        });
      });
    });
  }

  /**
   * Outbound connection to a known peer (used during join and reconnect).
   * Sends SERVER_HELLO_JOIN so the peer knows who we are.
   */
  connectToPeer(peerId: string, host: string, port: number): void {
    const ws = new WebSocket(`ws://${host}:${port}/ws`);

    ws.on("open", () => {
      const link = new ServerLink(ws, peerId);
      this.registerLink(peerId, link);

      const payload: ServerHelloJoinPayload = {
        host: this.host,
        port: this.port,
        sig_pubkey: this.crypto.getPublicKeyB64(),
      };
      link.send({
        type: ProtocolMessageType.SERVER_HELLO_JOIN,
        from: this.serverId,
        to: peerId,
        ts: Date.now(),
        payload,
      });
    });

    ws.on("error", (err) => {
      console.warn(`[MeshManager] Failed to connect to ${peerId}: ${err.message}`);
    });
  }

  // ── Introducer Role ───────────────────────────────────────────────────────

  /**
   * Handle an incoming SERVER_HELLO_JOIN from a server that wants to join.
   *
   * As introducer we:
   *   1. Validate / assign a UUID (resolve collisions)
   *   2. Pin the new server's public key
   *   3. Send SERVER_WELCOME with the full network snapshot
   *   4. Register the new peer connection
   */
  async handleHelloJoin(envelope: Envelope, ws: WebSocket): Promise<void> {
    const payload = envelope.payload as ServerHelloJoinPayload;
    let newId = envelope.from;

    // Resolve UUID collision
    if (newId === this.serverId || this.servers.has(newId)) {
      newId = uuidv4();
      console.log(`[MeshManager] UUID collision — reassigning to ${newId}`);
    }

    // Pin the public key before we do anything else
    this.serverPubKeys.set(newId, payload.sig_pubkey);

    // Build the servers snapshot (everything we know, including ourselves)
    const serversSnap: Record<string, { host: string; port: number; sig_pubkey: string }> = {
      [this.serverId]: {
        host: this.host,
        port: this.port,
        sig_pubkey: this.crypto.getPublicKeyB64(),
      },
    };
    for (const [id, addr] of this.serverAddrs) {
      serversSnap[id] = {
        host: addr[0],
        port: addr[1],
        sig_pubkey: this.serverPubKeys.get(id) ?? "",
      };
    }

    const serverAddrsSnap: Record<string, [string, number]> = {
      [this.serverId]: [this.host, this.port],
    };
    for (const [id, addr] of this.serverAddrs) {
      serverAddrsSnap[id] = addr;
    }

    const welcomePayload: ServerWelcomePayload = {
      assigned_id: newId,
      servers: serversSnap,
      serverAddrs: serverAddrsSnap,
      userLocations: this.getUserLocationsSnapshot?.() ?? {},
    };

    const welcomeEnvelope: Envelope = {
      type: ProtocolMessageType.SERVER_WELCOME,
      from: this.serverId,
      to: newId,
      ts: Date.now(),
      payload: welcomePayload as unknown as Record<string, unknown>,
      sig: await this.crypto.sign(
        ServerCrypto.canonicalizePayload(
          welcomePayload as unknown as Record<string, unknown>,
        ),
      ),
    };

    ws.send(JSON.stringify(welcomeEnvelope));

    // Register the connection and record their address
    const link = new ServerLink(ws, newId);
    this.registerLink(newId, link);
    this.serverAddrs.set(newId, [payload.host, payload.port]);

    console.log(`[MeshManager] Welcomed ${newId} at ${payload.host}:${payload.port}`);
  }

  // ── SERVER_ANNOUNCE ───────────────────────────────────────────────────────

  /**
   * Broadcast SERVER_ANNOUNCE to all current peers.
   * Called once after successfully joining the network.
   */
  async broadcastAnnounce(): Promise<void> {
    const payload: ServerAnnouncePayload = {
      host: this.host,
      port: this.port,
      sig_pubkey: this.crypto.getPublicKeyB64(),
    };
    const envelope: Envelope = {
      type: ProtocolMessageType.SERVER_ANNOUNCE,
      from: this.serverId,
      to: "*",
      ts: Date.now(),
      payload: payload as unknown as Record<string, unknown>,
      sig: await this.crypto.sign(
        ServerCrypto.canonicalizePayload(
          payload as unknown as Record<string, unknown>,
        ),
      ),
    };

    await this.seenCache.markSeen(envelope);
    this.broadcast(envelope);
  }

  /**
   * Handle an incoming SERVER_ANNOUNCE from another server.
   *
   * 1. SeenCache dedup check
   * 2. Verify transport signature (if we have their key pinned)
   * 3. Register the new peer in our tables
   * 4. Gossip forward to all other peers
   */
  async handleAnnounce(envelope: Envelope, fromLink: ServerLink): Promise<void> {
    if (await this.seenCache.hasSeen(envelope)) return;
    await this.seenCache.markSeen(envelope);

    const payload = envelope.payload as ServerAnnouncePayload;
    const pubKey = this.serverPubKeys.get(envelope.from);

    if (pubKey && envelope.sig) {
      const canonical = ServerCrypto.canonicalizePayload(
        payload as unknown as Record<string, unknown>,
      );
      if (!await ServerCrypto.verify(canonical, envelope.sig, pubKey)) {
        console.warn(`[MeshManager] Bad transport sig on SERVER_ANNOUNCE from ${envelope.from}`);
        return;
      }
    }

    if (!this.serverPubKeys.has(envelope.from)) {
      this.serverPubKeys.set(envelope.from, payload.sig_pubkey);
    }
    this.serverAddrs.set(envelope.from, [payload.host, payload.port]);

    console.log(`[MeshManager] Registered ${envelope.from} at ${payload.host}:${payload.port}`);

    // Forward to all peers except the one who sent it (loop avoidance)
    this.broadcast(envelope, fromLink.remoteId);
  }

  // ── Broadcast & Registration ──────────────────────────────────────────────

  /** Send an envelope to all connected peers, optionally excluding one. */
  broadcast(envelope: Envelope, excludeId?: string): void {
    for (const [id, link] of this.servers) {
      if (id !== excludeId) link.send(envelope);
    }
  }

  /**
   * Add a link to the servers map and wire its close handler.
   * Calls onPeerConnected so MeshServer can route messages through ProtocolHandler.
   */
  private registerLink(serverId: string, link: ServerLink): void {
    this.servers.set(serverId, link);

    link.onClose(() => {
      this.servers.delete(serverId);
      console.log(`[MeshManager] Peer ${serverId} disconnected`);
    });

    this.onPeerConnected?.(link);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Close all active peer WebSocket connections. Called during server shutdown. */
  disconnectAll(): void {
    for (const link of this.servers.values()) {
      link.close();
    }
    this.servers.clear();
  }

  getServerId(): string { return this.serverId; }
  getPeerCount(): number { return this.servers.size; }
  hasPeer(id: string): boolean { return this.servers.has(id); }
  getServerAddr(id: string): ServerAddr | undefined { return this.serverAddrs.get(id); }
  getPubKey(id: string): string | undefined { return this.serverPubKeys.get(id); }

  /**
   * Returns a snapshot of all currently connected peer links.
   * Used by HeartbeatManager to check liveness without exposing the Map directly.
   */
  getPeerEntries(): [string, ServerLink][] {
    return [...this.servers.entries()];
  }
}
