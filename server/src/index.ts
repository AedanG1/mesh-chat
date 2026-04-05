import { MeshServer } from "./MeshServer.js";

/**
 * Server entry point.
 *
 * Reads configuration from environment variables (the standard way
 * to configure Docker containers) and starts a MeshServer instance.
 *
 * Environment variables:
 *   SERVER_HOST     - IP/hostname to listen on (default: "0.0.0.0")
 *   SERVER_PORT     - Port number (default: 9000)
 *   DB_PATH         - Path to SQLite database file (default: "./mesh-chat.db")
 *   BOOTSTRAP_LIST  - Comma-separated "host:port" addresses of known servers
 */
async function main(): Promise<void> {
  const host = process.env.SERVER_HOST ?? "0.0.0.0";
  const port = parseInt(process.env.SERVER_PORT ?? "9000", 10);
  const dbPath = process.env.DB_PATH ?? "./mesh-chat.db";
  const bootstrapList = (process.env.BOOTSTRAP_LIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const server = new MeshServer({ host, port, dbPath, bootstrapList });

  await server.start();

  console.log(`MeshServer started on ${host}:${port}`);
  console.log(`Server ID: ${server.getServerId()}`);
  console.log(`Public key: ${server.getCrypto().getPublicKeyB64().slice(0, 40)}...`);

  if (bootstrapList.length > 0) {
    console.log(`Bootstrap list: ${bootstrapList.join(", ")}`);
  } else {
    console.log("No bootstrap list configured -- starting as seed node");
  }

  // Graceful shutdown on SIGINT (Ctrl+C) and SIGTERM (Docker stop)
  const shutdown = async () => {
    console.log("\nShutting down...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
