import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from "@mesh-chat/common";
import type { MeshManager } from "./MeshManager.js";

/**
 * Manages peer liveness for the mesh network.
 *
 * Two jobs, one timer:
 *
 *   1. SEND heartbeat — every HEARTBEAT_INTERVAL_MS (15s), broadcast a
 *      HEARTBEAT envelope to all connected peers so they know we're alive.
 *
 *   2. CHECK liveness — on the same tick, inspect each peer's
 *      `lastFrameReceived` timestamp. If more than HEARTBEAT_TIMEOUT_MS (45s)
 *      have elapsed without any frame from that peer, we consider it dead:
 *      close the connection and attempt to reconnect using the address stored
 *      in MeshManager.serverAddrs.
 *
 * OOP Pattern: Single Responsibility — heartbeat logic is completely
 * isolated from join/announce/routing logic in MeshManager.
 *
 * The class is designed for simple start/stop lifecycle management.
 * MeshServer calls start() after joining the network and stop() during
 * server shutdown.
 */
export class HeartbeatManager {
  private meshManager: MeshManager;
  private serverId: string;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(meshManager: MeshManager, serverId: string) {
    this.meshManager = meshManager;
    this.serverId = serverId;
  }

  /**
   * Start the heartbeat loop.
   *
   * Using setInterval rather than recursive setTimeout because we want
   * a consistent cadence — each tick fires at HEARTBEAT_INTERVAL_MS after
   * the *previous tick started*, not after it finished. For a lightweight
   * heartbeat, this difference is irrelevant, but it keeps the interval
   * predictable.
   */
  start(): void {
    if (this.interval !== null) return; // already running

    this.interval = setInterval(() => {
      this.sendHeartbeats();
      this.checkLiveness();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat loop. Called during server shutdown so the timer
   * does not fire after the server has closed its connections.
   */
  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Broadcast a HEARTBEAT envelope to all connected peers.
   *
   * HEARTBEAT has no meaningful payload — it exists purely so peers know
   * we're alive and can update their `lastFrameReceived` timestamp.
   * The spec says we also update `lastFrameReceived` on *any* received frame
   * (already done in ServerLink), so heartbeats keep both sides' clocks fresh.
   */
  private sendHeartbeats(): void {
    const heartbeat: Envelope = {
      type: ProtocolMessageType.HEARTBEAT,
      from: this.serverId,
      to: "*",
      ts: Date.now(),
      payload: {},
    };

    // meshManager.broadcast() sends to all currently connected peers.
    // We don't sign HEARTBEAT — there's nothing sensitive here, and verifying
    // every heartbeat would add CPU overhead for no security benefit.
    this.meshManager.broadcast(heartbeat);
  }

  /**
   * Check each peer's last-received timestamp and close + reconnect stale ones.
   *
   * A peer is "stale" if we haven't received any frame from them in more
   * than HEARTBEAT_TIMEOUT_MS (45s). Since every received frame (including
   * their heartbeats) updates `lastFrameReceived` on the ServerLink, a
   * stale link means the peer is truly unreachable.
   *
   * Reconnect strategy:
   *   - Look up the peer's address in serverAddrs (populated during join/announce)
   *   - Call connectToPeer() — this creates a new WebSocket and sends
   *     SERVER_HELLO_JOIN, following the same path as the initial join
   */
  private checkLiveness(): void {
    const now = Date.now();

    for (const [peerId, link] of this.meshManager.getPeerEntries()) {
      const elapsed = now - link.lastFrameReceived;

      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        console.warn(
          `[HeartbeatManager] Peer ${peerId} timed out (${Math.round(elapsed / 1000)}s). ` +
          `Closing and reconnecting.`,
        );

        // Close the dead connection — this triggers the onClose callback in
        // MeshManager which removes the peer from the servers map.
        link.close();

        // Attempt to reconnect using the stored address.
        const addr = this.meshManager.getServerAddr(peerId);
        if (addr) {
          const [host, port] = addr;
          // Small delay before reconnect so the close handshake can propagate.
          setTimeout(() => {
            this.meshManager.connectToPeer(peerId, host, port);
          }, 1000);
        } else {
          console.warn(`[HeartbeatManager] No address stored for ${peerId} — cannot reconnect.`);
        }
      }
    }
  }
}
