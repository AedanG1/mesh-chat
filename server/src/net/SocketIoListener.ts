import { Server as SocketIoServer, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";

/**
 * Callback invoked when a new Socket.io client connects.
 */
export type ClientConnectionCallback = (socket: Socket) => void;

/**
 * Accepts incoming client-to-server Socket.io connections.
 *
 * Socket.io handles its own HTTP upgrade path ("/socket.io"),
 * so it coexists with our WsListener ("/ws") on the same HTTP server.
 *
 * Socket.io provides features beyond raw WebSockets:
 *   - Automatic reconnection if the connection drops
 *   - Event-based messaging (emit/on with event names)
 *   - Fallback to HTTP long-polling if WebSocket isn't available
 *
 * We configure CORS to allow connections from the React client
 * during development (different origin/port).
 */
export class SocketIoListener {
  private io: SocketIoServer;
  private connectionCallback: ClientConnectionCallback | null = null;

  constructor(httpServer: HttpServer) {
    this.io = new SocketIoServer(httpServer, {
      // CORS configuration: allow the React dev server to connect.
      // In production you'd restrict this to your actual domain.
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    // The "connection" event fires each time a new client connects.
    this.io.on("connection", (socket: Socket) => {
      if (this.connectionCallback) {
        this.connectionCallback(socket);
      }
    });
  }

  /**
   * Register a callback for new client connections.
   * The MeshServer calls this to handle new users.
   */
  onConnection(callback: ClientConnectionCallback): void {
    this.connectionCallback = callback;
  }

  /** Returns the Socket.io server instance (for advanced use). */
  getServer(): SocketIoServer {
    return this.io;
  }

  /** Shut down the Socket.io server. */
  close(): void {
    this.io.close();
  }
}
