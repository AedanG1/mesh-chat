import type { Envelope } from "@mesh-chat/common";

/**
 * Callback type for receiving an Envelope from a connection.
 */
export type MessageCallback = (envelope: Envelope) => void;

/**
 * Callback type for when a connection closes.
 */
export type CloseCallback = () => void;

/**
 * Abstract base class for all WebSocket-style connections.
 *
 * In OOP, an abstract class defines an interface (what methods exist)
 * and optionally some shared implementation, but it CANNOT be
 * instantiated directly -- you must create a concrete subclass.
 *
 * We have two concrete subclasses:
 *   - ServerLink: wraps a native `ws` WebSocket (server-to-server)
 *   - ClientLink: wraps a Socket.io socket (client-to-server)
 *
 * Both share the concept of sending/receiving Envelopes and closing,
 * but the underlying transport differs. This base class lets the rest
 * of the code (MeshManager, PresenceManager, etc.) work with any
 * connection type without caring which transport it uses.
 *
 * This is the "Liskov Substitution Principle" in action: anywhere
 * a Link is expected, either a ServerLink or ClientLink can be used.
 */
export abstract class Link {
  /** UUID of the remote peer (server or user) on the other end. */
  remoteId: string;

  /** Callbacks registered via onMessage(). */
  protected messageCallbacks: MessageCallback[] = [];

  /** Callbacks registered via onClose(). */
  protected closeCallbacks: CloseCallback[] = [];

  constructor(remoteId: string) {
    this.remoteId = remoteId;
  }

  /**
   * Send an Envelope to the remote peer.
   * Each subclass implements this differently based on its transport.
   */
  abstract send(envelope: Envelope): void;

  /**
   * Close the connection gracefully.
   */
  abstract close(): void;

  /**
   * Register a callback to be invoked when an Envelope arrives.
   * Multiple callbacks can be registered; all will be called.
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * Register a callback to be invoked when the connection closes.
   */
  onClose(callback: CloseCallback): void {
    this.closeCallbacks.push(callback);
  }

  /**
   * Notify all registered message callbacks.
   * Called by subclasses when they receive a message from the transport.
   */
  protected notifyMessage(envelope: Envelope): void {
    for (const cb of this.messageCallbacks) {
      cb(envelope);
    }
  }

  /**
   * Notify all registered close callbacks.
   * Called by subclasses when the underlying transport closes.
   */
  protected notifyClose(): void {
    for (const cb of this.closeCallbacks) {
      cb();
    }
  }
}
