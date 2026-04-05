import http from "node:http";
import express from "express";
import cors from "cors";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { isValidEnvelope } from "@mesh-chat/common";
import type { Socket } from "socket.io";
import { Database } from "./db/Database.js";
import { UserRepository } from "./auth/UserRepository.js";
import { AuthController } from "./auth/AuthController.js";
import { ServerCrypto } from "./crypto/ServerCrypto.js";
import { PasswordService } from "./crypto/PasswordService.js";
import { WsListener } from "./net/WsListener.js";
import { SocketIoListener } from "./net/SocketIoListener.js";
import { ClientLink } from "./net/ClientLink.js";
import { MeshManager } from "./mesh/MeshManager.js";
import { HeartbeatManager } from "./mesh/HeartbeatManager.js";
import { SeenCache } from "./mesh/SeenCache.js";
import { PresenceManager } from "./presence/PresenceManager.js";
import { LocalUserManager } from "./presence/LocalUserManager.js";
import { ProtocolHandler } from "./routing/ProtocolHandler.js";
import { MessageRouter } from "./routing/MessageRouter.js";
import type { ServerLink } from "./net/ServerLink.js";

export interface MeshServerConfig {
  host: string;
  port: number;
  /** The hostname/IP this server advertises to peers for inbound connections.
   *  In Docker this is the container name (e.g. "server1"). Defaults to `host`. */
  advertiseHost?: string;
  dbPath: string;
  bootstrapList: string[];
  /** Max times to retry the bootstrap list when joining the mesh.
   *  Default 5 — high enough for Docker startup races. Set to 1 in tests. */
  meshJoinRetries?: number;
  /** Base delay (ms) between mesh join retries. Actual delay = base * attempt.
   *  Default 2000. Set to 0 in tests. */
  meshJoinBaseDelay?: number;
}

/**
 * Central orchestrator: owns all server components and manages their lifecycle.
 *
 * Phase 4 additions:
 *   - PresenceManager    (userLocations table, USER_ADVERTISE/REMOVE gossip)
 *   - LocalUserManager   (localUsers table, USER_HELLO → registration)
 *   - Socket.io wired    (client connections → USER_HELLO → LocalUserManager)
 *   - getUserLocationsSnapshot wired into MeshManager (for SERVER_WELCOME)
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

  // Mesh (Phase 3+)
  private seenCache!: SeenCache;
  private meshManager!: MeshManager;
  private heartbeatManager!: HeartbeatManager;
  private protocolHandler!: ProtocolHandler;

  // Presence (Phase 4)
  private presenceManager!: PresenceManager;
  private localUserManager!: LocalUserManager;

  // Routing (Phase 5)
  private messageRouter!: MessageRouter;

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
    // Allow cross-origin requests from the browser client.
    // In development and Docker (Option B), the client origin differs from the
    // server port, so we permit all origins here.
    this.app.use(cors());
    this.app.use(express.json());
    this.passwordService = new PasswordService();
    this.userRepo = new UserRepository(this.db);
    this.authController = new AuthController(this.userRepo, this.passwordService);
    this.app.use("/auth", this.authController.router);

    // 4. HTTP server shared by Express, WS, and Socket.io
    this.httpServer = http.createServer(this.app);
    this.wsListener = new WsListener(this.httpServer);
    this.socketIoListener = new SocketIoListener(this.httpServer);

    // 5. Mesh components (Phase 3)
    this.seenCache = new SeenCache();
    this.meshManager = new MeshManager(
      this.serverId,
      this.config.advertiseHost ?? this.config.host,
      this.config.port,
      this.crypto,
      this.seenCache,
    );
    this.protocolHandler = new ProtocolHandler(this.meshManager);

    // 6. Presence components (Phase 4)
    this.presenceManager = new PresenceManager(
      this.serverId,
      this.crypto,
      this.meshManager,
      this.seenCache,
    );
    this.localUserManager = new LocalUserManager(
      this.serverId,
      this.presenceManager,
      this.userRepo,
    );

    // Inject presence managers into ProtocolHandler via setter injection
    this.protocolHandler.setPresenceManagers(
      this.presenceManager,
      this.localUserManager,
    );

    // Phase 5: MessageRouter needs all the components above to exist first
    this.messageRouter = new MessageRouter(
      this.serverId,
      this.crypto,
      this.presenceManager,
      this.localUserManager,
      this.meshManager,
      this.userRepo,
    );
    this.protocolHandler.setMessageRouter(this.messageRouter);

    // Wire: relay presence events (USER_ADVERTISE/USER_REMOVE) to all
    // locally connected Socket.io clients for real-time user list updates
    this.presenceManager.onPresenceChange = (envelope) => {
      this.localUserManager.broadcastToLocalClients(envelope);
    };

    // Wire: plug userLocations snapshot into MeshManager so SERVER_WELCOME
    // includes current online users when a new server joins
    this.meshManager.getUserLocationsSnapshot = () =>
      this.presenceManager.getUserLocationsSnapshot();

    // Wire: new peer links → ProtocolHandler
    this.meshManager.onPeerConnected = (link: ServerLink) => {
      link.onMessage((envelope) => {
        this.protocolHandler.dispatch(envelope, link).catch((err) =>
          console.error("[MeshServer] dispatch error:", err),
        );
      });
    };

    // Wire: raw WS connections → first-frame routing
    this.wsListener.onConnection((ws: WebSocket) => {
      this.handleIncomingWs(ws);
    });

    // Wire: Socket.io client connections → ClientLink → ProtocolHandler
    this.socketIoListener.onConnection((socket: Socket) => {
      this.handleIncomingClient(socket);
    });

    // 7. Start listening (before joinNetwork so peers can reach us)
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.port, this.config.host, resolve);
    });

    // 8. Join the mesh
    await this.meshManager.joinNetwork(
      this.config.bootstrapList,
      this.config.meshJoinRetries,
      this.config.meshJoinBaseDelay,
    );
    this.serverId = this.meshManager.getServerId();

    // 9. Start heartbeat loop (after join so serverId is finalised)
    this.heartbeatManager = new HeartbeatManager(this.meshManager, this.serverId);
    this.heartbeatManager.start();
  }

  /**
   * Handle an incoming server-to-server WebSocket connection.
   * First frame must be SERVER_HELLO_JOIN.
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
          this.meshManager.handleHelloJoin(parsed, ws).catch((err) =>
            console.error("[MeshServer] handleHelloJoin error:", err),
          );
        } else {
          ws.close(1002, "Expected SERVER_HELLO_JOIN as first frame");
        }
      } catch {
        ws.close(1002, "Bad first frame");
      }
    });
  }

  /**
   * Handle a new Socket.io client connection.
   *
   * We wrap the socket in a ClientLink and attach the ProtocolHandler.
   * The client's first message must be USER_HELLO (per the spec).
   *
   * We give the link a temporary remoteId of "" until USER_HELLO
   * tells us the real userId.
   */
  private handleIncomingClient(socket: Socket): void {
    // Use a placeholder ID until USER_HELLO arrives.
    // ClientLink will update remoteId when we call handleHello.
    const link = new ClientLink(socket, "");

    link.onMessage((envelope) => {
      // On the first message, update the link's remoteId to the real userId
      if (link.remoteId === "") {
        link.remoteId = envelope.from;
      }
      this.protocolHandler.dispatch(envelope, link).catch((err) =>
        console.error("[MeshServer] dispatch error:", err),
      );
    });
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getServerId(): string { return this.serverId; }
  getCrypto(): ServerCrypto { return this.crypto; }
  getMeshManager(): MeshManager { return this.meshManager; }
  getPresenceManager(): PresenceManager { return this.presenceManager; }
  getLocalUserManager(): LocalUserManager { return this.localUserManager; }
  getApp(): express.Express { return this.app; }
  getHttpServer(): http.Server { return this.httpServer; }

  async stop(): Promise<void> {
    this.heartbeatManager?.stop();
    this.meshManager?.disconnectAll();
    this.wsListener?.close();
    this.socketIoListener?.close();

    (this.httpServer as unknown as { closeAllConnections?: () => void })
      .closeAllConnections?.();

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err) => (err ? reject(err) : resolve()));
    });

    this.db?.close();
  }
}
