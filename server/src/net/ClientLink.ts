import type { Socket } from "socket.io";
import type { Envelope } from "@mesh-chat/common";
import { isValidEnvelope } from "@mesh-chat/common";
import { Link } from "./Link.js";

/**
 * Concrete Link subclass for client-to-server Socket.io connections.
 *
 * Socket.io has a different API than raw WebSockets:
 *   - It uses .emit(eventName, data) instead of .send(data)
 *   - It uses .on(eventName, callback) for specific events
 *   - It has built-in reconnection, rooms, namespaces, etc.
 *
 * We use a custom event name "envelope" for all protocol messages.
 * This adapts the Socket.io interface to match our Link abstraction
 * so the rest of the server code doesn't need to know which
 * transport a connection uses.
 */
export class ClientLink extends Link {
  private socket: Socket;

  /**
   * @param socket   - A connected Socket.io Socket instance
   * @param remoteId - UUID of the remote user
   */
  constructor(socket: Socket, remoteId: string) {
    super(remoteId);
    this.socket = socket;

    // Listen for our custom "envelope" event.
    // When a client sends: socket.emit("envelope", data),
    // this handler fires with `data` as the argument.
    this.socket.on("envelope", (data: unknown) => {
      // Validate the shape before passing it through
      if (isValidEnvelope(data)) {
        this.notifyMessage(data);
      }
    });

    // Socket.io's "disconnect" event fires when the client disconnects.
    this.socket.on("disconnect", () => {
      this.notifyClose();
    });
  }

  /**
   * Send an Envelope to the client via Socket.io.
   * Uses the "envelope" event name so the client knows to parse it
   * as a protocol message.
   */
  send(envelope: Envelope): void {
    this.socket.emit("envelope", envelope);
  }

  /** Disconnect the Socket.io connection. */
  close(): void {
    this.socket.disconnect(true);
  }
}
