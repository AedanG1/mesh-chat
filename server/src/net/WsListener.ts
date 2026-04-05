import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";

/**
 * Callback invoked when a new raw WebSocket connection arrives.
 * The MeshServer will register a handler to identify the connecting
 * peer (server or user) from their first message.
 */
export type WsConnectionCallback = (ws: WebSocket) => void;

/**
 * Accepts incoming server-to-server WebSocket connections.
 *
 * Uses the `ws` library's WebSocketServer, which can be attached
 * to an existing HTTP server. This lets us share the same port
 * for both Express HTTP routes and WebSocket upgrades.
 *
 * The WebSocketServer listens for HTTP upgrade requests at a specific
 * path ("/ws") to distinguish server WS connections from Socket.io
 * connections (which use "/socket.io" by default).
 */
export class WsListener {
  private wss: WebSocketServer;
  private connectionCallback: WsConnectionCallback | null = null;

  /**
   * Creates a WebSocketServer attached to the given HTTP server.
   *
   * Setting `noServer: true` means we handle the HTTP upgrade manually
   * so we can route different paths to different WebSocket servers
   * (ws for server-to-server, socket.io for client-to-server).
   */
  constructor(httpServer: HttpServer) {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle the HTTP "upgrade" event to intercept WebSocket handshakes.
    // Only upgrade requests to "/ws" are handled here.
    httpServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

      if (pathname === "/ws") {
        // Complete the WebSocket handshake and emit a "connection" event
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit("connection", ws, request);
        });
      }
      // If the path isn't "/ws", we leave it alone -- Socket.io
      // will handle "/socket.io" upgrades separately.
    });

    // When a new WebSocket connection is established, notify our callback
    this.wss.on("connection", (ws: WebSocket) => {
      if (this.connectionCallback) {
        this.connectionCallback(ws);
      }
    });
  }

  /**
   * Register a callback for new incoming WebSocket connections.
   * The MeshServer calls this to handle new server peers.
   */
  onConnection(callback: WsConnectionCallback): void {
    this.connectionCallback = callback;
  }

  /** Shut down the WebSocket server. */
  close(): void {
    this.wss.close();
  }
}
