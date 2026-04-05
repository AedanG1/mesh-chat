import { io, type Socket } from "socket.io-client";
import { isValidEnvelope, type Envelope } from "@mesh-chat/common";

/**
 * Thin wrapper around the Socket.io client connection to the server.
 *
 * Responsibilities:
 *   - Manage connect / disconnect lifecycle
 *   - Send Envelope objects over the "envelope" event channel
 *   - Receive and validate inbound Envelope objects
 *   - Expose typed callbacks for connect, disconnect, and envelope events
 *
 * OOP Pattern: Facade — hides the raw Socket.io API behind a smaller,
 * domain-focused interface. Callers only deal with Envelopes and lifecycle
 * events; they never touch `socket.emit` or `socket.on` directly.
 *
 * Why validate inbound envelopes here?
 *   The server should only send valid envelopes, but validating at the
 *   boundary means the rest of the client can trust that any Envelope
 *   it receives has the correct shape without defensive checks everywhere.
 */
export class SocketService {
  private socket: Socket | null = null;

  private envelopeCallbacks: ((envelope: Envelope) => void)[] = [];
  private connectCallbacks: (() => void)[] = [];
  private disconnectCallbacks: (() => void)[] = [];

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Open a Socket.io connection to the given server URL.
   *
   * Socket.io connects automatically on construction; the `connect`
   * event fires once the handshake with the server completes.
   *
   * Calling connect() when already connected is a no-op to prevent
   * duplicate socket instances.
   *
   * @param serverUrl - Full URL of the server, e.g. "http://127.0.0.1:3000"
   */
  connect(serverUrl: string): void {
    if (this.socket?.connected) return;

    // Disconnect any previous (disconnected) socket before creating a new one
    this.socket?.disconnect();

    this.socket = io(serverUrl);

    this.socket.on("connect", () => {
      this.connectCallbacks.forEach((cb) => cb());
    });

    this.socket.on("disconnect", () => {
      this.disconnectCallbacks.forEach((cb) => cb());
    });

    // The server emits all messages on the "envelope" event channel.
    // We validate the shape before passing to registered callbacks.
    this.socket.on("envelope", (data: unknown) => {
      if (isValidEnvelope(data)) {
        this.envelopeCallbacks.forEach((cb) => cb(data));
      }
      // Invalid envelopes are silently dropped — the server controls what
      // it sends, and malformed data here likely means a version mismatch.
    });
  }

  /**
   * Close the connection and clean up listeners.
   * Safe to call even if not connected.
   */
  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Send an Envelope to the server.
   *
   * Throws if called while not connected — callers should check
   * isConnected() before sending or handle the error.
   *
   * @param envelope - The Envelope to send
   */
  send(envelope: Envelope): void {
    if (!this.socket?.connected) {
      throw new Error("SocketService: cannot send — not connected");
    }
    this.socket.emit("envelope", envelope);
  }

  // ── Event Registration ────────────────────────────────────────────────────

  /**
   * Register a callback for inbound Envelope messages.
   * Multiple callbacks can be registered; all are called for each message.
   */
  onEnvelope(callback: (envelope: Envelope) => void): void {
    this.envelopeCallbacks.push(callback);
  }

  /** Register a callback for when the connection is established. */
  onConnect(callback: () => void): void {
    this.connectCallbacks.push(callback);
  }

  /** Register a callback for when the connection is lost. */
  onDisconnect(callback: () => void): void {
    this.disconnectCallbacks.push(callback);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}
