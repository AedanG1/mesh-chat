import WebSocket from "ws";
import type { Envelope } from "@mesh-chat/common";
import { isValidEnvelope } from "@mesh-chat/common";
import { Link } from "./Link.js";

/**
 * Concrete Link subclass for server-to-server WebSocket connections.
 *
 * Wraps a native `ws` WebSocket instance. Adds heartbeat tracking
 * via `lastFrameReceived` -- the HeartbeatManager checks this
 * timestamp to detect dead connections (45s timeout).
 *
 * Usage:
 *   const link = new ServerLink(ws, remoteServerId);
 *   link.onMessage((envelope) => { ... });
 *   link.send(someEnvelope);
 */
export class ServerLink extends Link {
  private ws: WebSocket;

  /** Unix timestamp (ms) of the last frame received from this server. */
  lastFrameReceived: number;

  /**
   * @param ws       - An already-connected ws WebSocket instance
   * @param remoteId - UUID of the remote server
   */
  constructor(ws: WebSocket, remoteId: string) {
    super(remoteId);
    this.ws = ws;
    this.lastFrameReceived = Date.now();

    // Wire up the ws event handlers to our Link callback system.
    // The "message" event fires for each incoming WebSocket text frame.
    this.ws.on("message", (data: WebSocket.Data) => {
      this.lastFrameReceived = Date.now();

      try {
        // Parse the raw text frame as JSON
        const parsed: unknown = JSON.parse(data.toString());

        // Validate the shape before treating it as an Envelope
        if (isValidEnvelope(parsed)) {
          this.notifyMessage(parsed);
        }
      } catch {
        // Invalid JSON -- silently drop the frame.
        // In a production system you might log this.
      }
    });

    // The "close" event fires when the WebSocket connection ends.
    this.ws.on("close", () => {
      this.notifyClose();
    });
  }

  /**
   * Send an Envelope to the remote server as a JSON text frame.
   * Only sends if the WebSocket is in the OPEN state.
   */
  send(envelope: Envelope): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
    }
  }

  /** Close the WebSocket connection with a normal close code (1000). */
  close(): void {
    this.ws.close(1000);
  }
}
