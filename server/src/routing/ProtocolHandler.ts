import WebSocket from "ws";
import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";
import type { MeshManager } from "../mesh/MeshManager.js";
import type { PresenceManager } from "../presence/PresenceManager.js";
import type { LocalUserManager } from "../presence/LocalUserManager.js";
import type { ServerLink } from "../net/ServerLink.js";
import type { ClientLink } from "../net/ClientLink.js";
import type { Link } from "../net/Link.js";

/**
 * Central message dispatch hub.
 *
 * Every inbound Envelope — from a server-to-server WS connection
 * or a client Socket.io connection — flows through `dispatch()`.
 *
 * Design: ProtocolHandler does NOT contain message logic itself.
 * It reads `type` and delegates to the correct manager. Each manager
 * owns the logic for its domain (mesh, presence, routing).
 *
 * OOP Pattern: Command pattern — each message type maps to a handler
 * method on a specific manager class.
 *
 * Managers are injected (Dependency Injection) so each can be
 * tested independently with mock collaborators.
 */
export class ProtocolHandler {
  private meshManager: MeshManager;
  private presenceManager: PresenceManager | null = null;
  private localUserManager: LocalUserManager | null = null;
  // Phase 5: messageRouter injected here

  constructor(meshManager: MeshManager) {
    this.meshManager = meshManager;
  }

  /**
   * Inject Phase 4 managers after construction.
   * Called by MeshServer once PresenceManager and LocalUserManager exist.
   *
   * We use setter injection (rather than constructor injection) here
   * because PresenceManager depends on MeshManager, and LocalUserManager
   * depends on PresenceManager — all three are created by MeshServer in
   * a specific order. Setter injection avoids circular constructor arguments.
   */
  setPresenceManagers(
    presenceManager: PresenceManager,
    localUserManager: LocalUserManager,
  ): void {
    this.presenceManager = presenceManager;
    this.localUserManager = localUserManager;
  }

  /**
   * Dispatch an inbound Envelope to the appropriate handler.
   *
   * @param envelope - The validated Envelope received from the wire
   * @param link     - The connection the message arrived on
   * @param rawWs    - Raw WebSocket, only needed for SERVER_HELLO_JOIN
   */
  dispatch(envelope: Envelope, link: Link, rawWs?: WebSocket): void {
    switch (envelope.type) {
      // ── Server-to-Server ───────────────────────────────────────────────

      case ProtocolMessageType.SERVER_HELLO_JOIN:
        if (rawWs) {
          this.meshManager.handleHelloJoin(envelope, rawWs);
        }
        break;

      case ProtocolMessageType.SERVER_ANNOUNCE:
        this.meshManager.handleAnnounce(envelope, link as ServerLink);
        break;

      case ProtocolMessageType.SERVER_WELCOME:
        // Handled inline during the join handshake; unexpected here.
        break;

      case ProtocolMessageType.HEARTBEAT:
        // lastFrameReceived updated automatically in ServerLink on any message.
        break;

      // ── User Presence ──────────────────────────────────────────────────

      case ProtocolMessageType.USER_HELLO:
        // USER_HELLO arrives from a client on a ClientLink.
        // LocalUserManager validates, registers, and triggers gossip.
        this.localUserManager?.handleHello(envelope, link as ClientLink);
        break;

      case ProtocolMessageType.USER_ADVERTISE:
        // Arriving from a peer server — update userLocations and gossip forward.
        this.presenceManager?.handleAdvertise(envelope, link as ServerLink);
        break;

      case ProtocolMessageType.USER_REMOVE:
        // Arriving from a peer server — conditionally remove and gossip forward.
        this.presenceManager?.handleRemove(envelope, link as ServerLink);
        break;

      // ── Messaging (Phase 5) ───────────────────────────────────────────

      case ProtocolMessageType.MSG_DIRECT:
      case ProtocolMessageType.SERVER_DELIVER:
      case ProtocolMessageType.USER_DELIVER:
        // TODO Phase 5: delegate to MessageRouter
        break;

      // ── Control ───────────────────────────────────────────────────────

      case ProtocolMessageType.CTRL_CLOSE:
        link.close();
        break;

      case ProtocolMessageType.ERROR:
        console.warn(`[ProtocolHandler] ERROR from ${envelope.from}:`, envelope.payload);
        break;

      default:
        console.warn(`[ProtocolHandler] Unknown type: ${envelope.type}`);
    }
  }
}
