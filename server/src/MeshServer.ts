import http from "node:http";
import express from "express";
import { Database } from "./db/Database.js";
import { UserRepository } from "./auth/UserRepository.js";
import { AuthController } from "./auth/AuthController.js";
import { ServerCrypto } from "./crypto/ServerCrypto.js";
import { PasswordService } from "./crypto/PasswordService.js";
import { WsListener } from "./net/WsListener.js";
import { SocketIoListener } from "./net/SocketIoListener.js";

/**
 * Configuration for a MeshServer instance.
 */
export interface MeshServerConfig {
  host: string;          // IP/hostname this server listens on
  port: number;          // Port number for HTTP + WS + Socket.io
  dbPath: string;        // Path to SQLite database file (":memory:" for tests)
  bootstrapList: string[]; // List of "host:port" addresses of known servers
}

/**
 * The central orchestrator that owns and coordinates all server components.
 *
 * OOP concept: Composition over Inheritance.
 * MeshServer doesn't inherit from anything. Instead, it "composes"
 * (creates and owns) instances of each component class:
 *   - Database + UserRepository (persistent storage)
 *   - ServerCrypto (cryptographic operations)
 *   - PasswordService (password hashing)
 *   - AuthController (HTTP auth routes)
 *   - WsListener (server-to-server connections)
 *   - SocketIoListener (client-to-server connections)
 *
 * This keeps each class focused on a single responsibility (SRP)
 * while MeshServer handles the wiring and lifecycle.
 *
 * Phase 2 skeleton: starts Express, WS, and Socket.io listeners.
 * Mesh joining, presence, routing, and heartbeat come in later phases.
 */
export class MeshServer {
  private config: MeshServerConfig;

  // Core components
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

  // Server identity (assigned during startup)
  private serverId: string = "";

  constructor(config: MeshServerConfig) {
    this.config = config;
  }

  /**
   * Initialize all components and start listening.
   *
   * This is async because ServerCrypto.create() generates an RSA-4096
   * keypair which is CPU-intensive and done asynchronously.
   *
   * Startup sequence:
   * 1. Generate server keypair and UUID
   * 2. Open database and create schema
   * 3. Set up Express with JSON parsing and auth routes
   * 4. Create HTTP server and attach WS + Socket.io listeners
   * 5. Start listening on the configured port
   */
  async start(): Promise<void> {
    // 1. Generate server identity
    //    The server needs a UUID before joining the network.
    //    For Phase 2, we generate one locally. In Phase 3,
    //    the introducer may assign a different ID.
    const { v4: uuidv4 } = await import("uuid");
    this.serverId = uuidv4();

    // Generate the RSASSA-PSS keypair for transport signatures
    this.crypto = await ServerCrypto.create();

    // 2. Open the database
    this.db = new Database(this.config.dbPath);

    // 3. Set up Express
    this.app = express();

    // express.json() middleware parses incoming JSON request bodies.
    // Without this, req.body would be undefined.
    this.app.use(express.json());

    // Create the auth components and mount the routes
    this.passwordService = new PasswordService();
    this.userRepo = new UserRepository(this.db);
    this.authController = new AuthController(this.userRepo, this.passwordService);
    this.app.use("/auth", this.authController.router);

    // 4. Create HTTP server
    //    We create the HTTP server ourselves (instead of letting Express
    //    create one) so we can share it with WS and Socket.io.
    this.httpServer = http.createServer(this.app);

    // Attach the WebSocket listener for server-to-server connections
    this.wsListener = new WsListener(this.httpServer);

    // Attach the Socket.io listener for client-to-server connections
    this.socketIoListener = new SocketIoListener(this.httpServer);

    // TODO (Phase 3): Wire up wsListener.onConnection() to handle
    //   incoming server connections and mesh joining
    // TODO (Phase 4): Wire up socketIoListener.onConnection() to handle
    //   incoming client connections and user presence

    // 5. Start listening
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.port, this.config.host, () => {
        resolve();
      });
    });
  }

  /** Returns the server's UUID. */
  getServerId(): string {
    return this.serverId;
  }

  /** Returns the server's crypto instance. */
  getCrypto(): ServerCrypto {
    return this.crypto;
  }

  /** Returns the Express app (useful for testing with supertest). */
  getApp(): express.Express {
    return this.app;
  }

  /** Returns the underlying HTTP server (useful for testing). */
  getHttpServer(): http.Server {
    return this.httpServer;
  }

  /**
   * Gracefully shut down all components.
   * Call this when the server is stopping.
   */
  async stop(): Promise<void> {
    this.wsListener?.close();
    this.socketIoListener?.close();

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.db?.close();
  }
}
