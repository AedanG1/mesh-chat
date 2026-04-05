import http from "node:http";
import express from "express";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { isValidEnvelope } from "@mesh-chat/common";
import { Database } from "./db/Database.js";
import { UserRepository } from "./auth/UserRepository.js";
import { AuthController } from "./auth/AuthController.js";
import { ServerCrypto } from "./crypto/ServerCrypto.js";
import { PasswordService } from "./crypto/PasswordService.js";
import { WsListener } from "./net/WsListener.js";
import { SocketIoListener } from "./net/SocketIoListener.js";
import { MeshManager } from "./mesh/MeshManager.js";
import { SeenCache } from "./mesh/SeenCache.js";
import { ProtocolHandler } from "./routing/ProtocolHandler.js";
import type { ServerLink } from "./net/ServerLink.js";

export interface MeshServerConfig {
  host: string;
  port: number;
  dbPath: string;
  bootstrapList: string[];
}

/**
 * Central orchestrator: owns all server components and manages their lifecycle.
 *
 * Phase 3 additions:
 *   - SeenCache         (loop avoidance for broadcast messages)
 *   - MeshManager       (mesh topology, join handshake, broadcast)
 *   - ProtocolHandler   (message dispatch hub)
 *   - WsListener wired  (routes raw WS connections to MeshManager)
 */
export class MeshServer {
  private config: MeshServerConfig;

  // Auth & persistence
  private db!: Database;
  private crypto!: ServerCrypto;
  private passwordService!: PasswordService;
  private userRepo!: UserRepository;
  private authController!: AuthController;

  // Networking
  private app!: express.Express;
  private httpServer!: http.Server;
  private wsListener!: WsListener;
  private socketIoListener!: SocketIoListener;

  // Mesh (Phase 3)
  private seenCache!: SeenCache;
  private meshManager!: MeshManager;
  private protocolHandler!: ProtocolHandler;

  private serverId: string = "";

  constructor(config: MeshServerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    // 1. Server identity
    this.serverId = uuidv4();
    this.crypto = await ServerCrypto.create();

    // 2. Database
    this.db = new Database(this.config.dbPath);

    // 3. Express + auth routes
    this.app = express();
    this.app.use(express.json());
    this.passwordService = new PasswordService();
    this.userRepo = new UserRepository(this.db);
    this.authController = new AuthController(this.userRepo, this.passwordService);
    this.app.use("/auth", this.authController.router);

    // 4. HTTP server shared by Express, WS, and Socket.io
    this.httpServer = http.createServer(this.app);
    this.wsListener = new WsListener(this.httpServer);
    this.socketIoListener = new SocketIoListener(this.httpServer);

    // 5. Mesh components
    this.seenCache = new SeenCache();
    this.meshManager = new MeshManager(
      this.serverId,
      this.config.host,
      this.config.port,
      this.crypto,
      this.seenCache,
    );
    this.protocolHandler = new ProtocolHandler(this.meshManager);

    // Wire: when MeshManager establishes any new peer link, attach
    // the ProtocolHandler message callback to it.
    this.meshManager.onPeerConnected = (link: ServerLink) => {
      link.onMessage((envelope) => {
        this.protocolHandler.dispatch(envelope, link);
      });
    };

    // Wire: when a raw WS connection arrives on /ws, read the first
    // frame to identify whether it's a SERVER_HELLO_JOIN.
    this.wsListener.onConnection((ws: WebSocket) => {
      this.handleIncomingWs(ws);
    });

    // TODO (Phase 4): Wire socketIoListener.onConnection() for clients

    // 6. Start listening (must be before joinNetwork so peers can call back)
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.port, this.config.host, resolve);
    });

    // 7. Join the mesh
    await this.meshManager.joinNetwork(this.config.bootstrapList);

    // Sync serverId in case the introducer reassigned it
    this.serverId = this.meshManager.getServerId();
  }

  /**
   * Route a new raw WebSocket connection.
   *
   * We inspect the first frame to identify the peer.
   * The spec requires SERVER_HELLO_JOIN as the first message
   * from any connecting server.
   */
  private handleIncomingWs(ws: WebSocket): void {
    ws.once("message", (data: WebSocket.Data) => {
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (!isValidEnvelope(parsed)) {
          ws.close(1002, "Bad first frame");
          return;
        }

        if (parsed.type === "SERVER_HELLO_JOIN") {
          // Delegate to MeshManager, which wraps the WS into a ServerLink
          this.meshManager.handleHelloJoin(parsed, ws);
        } else {
          ws.close(1002, "Expected SERVER_HELLO_JOIN as first frame");
        }
      } catch {
        ws.close(1002, "Bad first frame");
      }
    });
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getServerId(): string { return this.serverId; }
  getCrypto(): ServerCrypto { return this.crypto; }
  getMeshManager(): MeshManager { return this.meshManager; }
  getApp(): express.Express { return this.app; }
  getHttpServer(): http.Server { return this.httpServer; }

  async stop(): Promise<void> {
    // Close all peer WebSocket connections first, otherwise they keep
    // the HTTP server alive and httpServer.close() never fires its callback.
    this.meshManager?.disconnectAll();
    this.wsListener?.close();
    this.socketIoListener?.close();

    // Force-close any remaining keep-alive connections (Node 18.2+).
    // Without this, the HTTP server waits indefinitely for idle connections.
    (this.httpServer as unknown as { closeAllConnections?: () => void })
      .closeAllConnections?.();

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err) => (err ? reject(err) : resolve()));
    });

    this.db?.close();
  }
}
