import WebSocket from "ws";
import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";
import type { MeshManager } from "../mesh/MeshManager.js";
import type { PresenceManager } from "../presence/PresenceManager.js";
import type { LocalUserManager } from "../presence/LocalUserManager.js";
import type { MessageRouter } from "./MessageRouter.js";
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
  private messageRouter: MessageRouter | null = null;

  constructor(meshManager: MeshManager) {
    this.meshManager = meshManager;
  }

  /**
   * Inject Phase 4 managers after construction.
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

  /** Inject Phase 5 MessageRouter after construction. */
  setMessageRouter(messageRouter: MessageRouter): void {
    this.messageRouter = messageRouter;
  }

  /**
   * Dispatch an inbound Envelope to the appropriate handler.
   *
   * @param envelope - The validated Envelope received from the wire
   * @param link     - The connection the message arrived on
   * @param rawWs    - Raw WebSocket, only needed for SERVER_HELLO_JOIN
   */
  async dispatch(envelope: Envelope, link: Link, rawWs?: WebSocket): Promise<void> {
    switch (envelope.type) {
      // ── Server-to-Server ───────────────────────────────────────────────

      case ProtocolMessageType.SERVER_HELLO_JOIN:
        if (rawWs) {
          await this.meshManager.handleHelloJoin(envelope, rawWs);
        }
        break;

      case ProtocolMessageType.SERVER_ANNOUNCE:
        await this.meshManager.handleAnnounce(envelope, link as ServerLink);
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
        await this.localUserManager?.handleHello(envelope, link as ClientLink);
        break;

      case ProtocolMessageType.USER_ADVERTISE:
        // Arriving from a peer server — update userLocations and gossip forward.
        await this.presenceManager?.handleAdvertise(envelope, link as ServerLink);
        break;

      case ProtocolMessageType.USER_REMOVE:
        // Arriving from a peer server — conditionally remove and gossip forward.
        await this.presenceManager?.handleRemove(envelope, link as ServerLink);
        break;

      // ── Messaging ─────────────────────────────────────────────────────

      case ProtocolMessageType.MSG_DIRECT:
        // From a local client: route to local or remote recipient.
        await this.messageRouter?.handleDirect(envelope, link);
        break;

      case ProtocolMessageType.SERVER_DELIVER:
        // From a peer server: verify transport sig and deliver locally.
        await this.messageRouter?.handleServerDeliver(envelope, link as ServerLink);
        break;

      case ProtocolMessageType.USER_DELIVER:
        // USER_DELIVER is only sent BY the server TO clients, never received.
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
