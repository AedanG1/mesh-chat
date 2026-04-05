import WebSocket from "ws";
import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";
import type { MeshManager } from "../mesh/MeshManager.js";
import type { ServerLink } from "../net/ServerLink.js";
import type { Link } from "../net/Link.js";

/**
 * Central message dispatch hub.
 *
 * Every inbound Envelope — from either a server-to-server WS connection
 * or a client Socket.io connection — flows through `dispatch()`.
 *
 * Design: the ProtocolHandler does NOT contain message logic itself.
 * It reads the `type` field and delegates to the correct manager
 * (MeshManager, PresenceManager, MessageRouter, etc.). This keeps
 * each concern in the class that owns it.
 *
 * OOP Pattern: this is similar to the Command pattern — each message
 * type maps to a handler method on a specific manager.
 *
 * Managers are injected (dependency injection) rather than created here,
 * which makes the ProtocolHandler easy to test with mock managers.
 */
export class ProtocolHandler {
  private meshManager: MeshManager;

  // Phase 4: PresenceManager will be injected here
  // Phase 5: MessageRouter will be injected here

  constructor(meshManager: MeshManager) {
    this.meshManager = meshManager;
  }

  /**
   * Dispatch an inbound Envelope to the appropriate handler.
   *
   * @param envelope - The validated Envelope received from the wire
   * @param link     - The connection the message arrived on
   * @param rawWs    - The raw WebSocket (needed for SERVER_HELLO_JOIN,
   *                   where MeshManager wraps it into a ServerLink itself)
   */
  dispatch(envelope: Envelope, link: Link, rawWs?: WebSocket): void {
    switch (envelope.type) {
      // ── Server-to-Server ───────────────────────────────────────────────

      case ProtocolMessageType.SERVER_HELLO_JOIN:
        // A new server is trying to join. We act as introducer.
        // rawWs must be provided so MeshManager can wrap it into a ServerLink.
        if (rawWs) {
          this.meshManager.handleHelloJoin(envelope, rawWs);
        }
        break;

      case ProtocolMessageType.SERVER_ANNOUNCE:
        // A server is announcing its presence after joining.
        // We register it and gossip the announcement forward.
        this.meshManager.handleAnnounce(envelope, link as ServerLink);
        break;

      case ProtocolMessageType.SERVER_WELCOME:
        // SERVER_WELCOME is only handled inline during the join handshake
        // (in MeshManager.tryJoinVia). If we somehow receive one here,
        // it's unexpected -- silently ignore.
        break;

      case ProtocolMessageType.HEARTBEAT:
        // Updating lastFrameReceived is handled in ServerLink itself
        // (any incoming message updates the timestamp). No extra logic needed.
        break;

      // ── User Presence (Phase 4) ────────────────────────────────────────

      case ProtocolMessageType.USER_HELLO:
      case ProtocolMessageType.USER_ADVERTISE:
      case ProtocolMessageType.USER_REMOVE:
        // TODO Phase 4: delegate to PresenceManager
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
        console.warn(`[ProtocolHandler] Received ERROR from ${envelope.from}:`, envelope.payload);
        break;

      default:
        console.warn(`[ProtocolHandler] Unknown message type: ${envelope.type}`);
    }
  }
}
