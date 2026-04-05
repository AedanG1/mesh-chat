import { describe, it, expect, afterEach } from "vitest";
import { MeshServer } from "../../src/MeshServer.js";

/**
 * Helper to start a MeshServer on a given port with a given bootstrap list.
 * Uses in-memory SQLite so no files are written.
 */
async function startServer(port: number, bootstrapList: string[] = []): Promise<MeshServer> {
  const server = new MeshServer({
    host: "127.0.0.1",
    port,
    dbPath: ":memory:",
    bootstrapList,
  });
  await server.start();
  return server;
}

/** Small delay helper to let async gossip propagate between servers. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MeshManager — server join integration", () => {
  const servers: MeshServer[] = [];

  // Stop all servers after each test to free ports.
  // Timeout is generous because Socket.io teardown can be slow.
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    servers.length = 0;
  }, 15000);

  it("seed server starts with no peers", async () => {
    const seed = await startServer(19001);
    servers.push(seed);

    expect(seed.getMeshManager().getPeerCount()).toBe(0);
  });

  it("server B joins server A and both have one peer", async () => {
    // Start server A (seed — no bootstrap list)
    const serverA = await startServer(19002);
    servers.push(serverA);

    // Start server B pointing at A's address
    const serverB = await startServer(19003, ["127.0.0.1:19002"]);
    servers.push(serverB);

    // Give the SERVER_HELLO_JOIN → SERVER_WELCOME → SERVER_ANNOUNCE
    // round trip a moment to complete
    await wait(300);

    // B should have registered A as a peer
    expect(serverB.getMeshManager().getPeerCount()).toBe(1);

    // A should have registered B as a peer (via handleHelloJoin)
    expect(serverA.getMeshManager().getPeerCount()).toBe(1);
  });

  it("server B receives A's server ID in the network state", async () => {
    const serverA = await startServer(19004);
    servers.push(serverA);

    const serverB = await startServer(19005, ["127.0.0.1:19004"]);
    servers.push(serverB);

    await wait(300);

    const idA = serverA.getServerId();

    // B should know A's address after receiving SERVER_WELCOME
    const addr = serverB.getMeshManager().getServerAddr(idA);
    expect(addr).toBeDefined();
    expect(addr![0]).toBe("127.0.0.1");
    expect(addr![1]).toBe(19004);
  });

  it("three servers all connect to each other", async () => {
    const serverA = await startServer(19006);
    servers.push(serverA);

    // B joins via A
    const serverB = await startServer(19007, ["127.0.0.1:19006"]);
    servers.push(serverB);

    await wait(300);

    // C joins via A -- should also learn about B via SERVER_ANNOUNCE gossip
    const serverC = await startServer(19008, ["127.0.0.1:19006"]);
    servers.push(serverC);

    // Give enough time for SERVER_ANNOUNCE gossip to propagate
    await wait(500);

    // Each server should have 2 peers
    expect(serverA.getMeshManager().getPeerCount()).toBe(2);
    expect(serverB.getMeshManager().getPeerCount()).toBe(2);
    expect(serverC.getMeshManager().getPeerCount()).toBe(2);
  });
}, 15000); // increase timeout -- RSA key gen + real WS connections
