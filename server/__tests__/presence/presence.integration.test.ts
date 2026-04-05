import { describe, it, expect, afterEach } from "vitest";
import { io as ioClient } from "socket.io-client";
import type { Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { toBase64Url, ProtocolMessageType, type Envelope } from "@mesh-chat/common";
import { MeshServer } from "../../src/MeshServer.js";

function startServer(port: number, bootstrapList: string[] = []): Promise<MeshServer> {
  const s = new MeshServer({ host: "127.0.0.1", port, dbPath: ":memory:", bootstrapList });
  return s.start().then(() => s);
}

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Generate an RSA-PSS key pair using WebCrypto and return the
 * base64url-encoded public key. We use 2048-bit keys for test speed.
 */
async function genKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048, // 2048 for test speed
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pubDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return {
    pubKeyB64: toBase64Url(new Uint8Array(pubDer)),
    privateKey: keyPair.privateKey,
  };
}

describe("User Presence — integration", () => {
  const servers: MeshServer[] = [];
  const sockets: ClientSocket[] = [];

  afterEach(async () => {
    sockets.forEach((s) => s.disconnect());
    sockets.length = 0;
    await Promise.all(servers.map((s) => s.stop()));
    servers.length = 0;
  }, 20000);

  it("USER_HELLO registers user locally and gossips USER_ADVERTISE to a peer server", async () => {
    // Start two servers
    const serverA = await startServer(19100);
    const serverB = await startServer(19101, ["127.0.0.1:19100"]);
    servers.push(serverA, serverB);
    await wait(300); // let mesh join complete

    // Generate key pairs for the test user
    const sigKeys = await genKeyPair();
    const encKeys = await genKeyPair();
    const clientHash = "test-client-hash-abc123";

    // Register the user on server A via HTTP
    const regRes = await request(serverA.getApp())
      .post("/auth/register")
      .send({
        username: "alice",
        clientHash,
        enc_pubkey: encKeys.pubKeyB64,
        sig_pubkey: sigKeys.pubKeyB64,
        enc_privkey_store: "fake-enc-blob",
        sig_privkey_store: "fake-sig-blob",
      });
    expect(regRes.status).toBe(201);
    const { userId } = regRes.body as { userId: string };

    // Connect a Socket.io client to server A
    const clientSocket = ioClient("http://127.0.0.1:19100");
    sockets.push(clientSocket);

    await new Promise<void>((resolve, reject) => {
      clientSocket.on("connect", resolve);
      clientSocket.on("connect_error", reject);
      setTimeout(() => reject(new Error("Socket.io connect timeout")), 5000);
    });

    // Send USER_HELLO
    const helloEnvelope: Envelope = {
      type: ProtocolMessageType.USER_HELLO,
      from: userId,
      to: serverA.getServerId(),
      ts: Date.now(),
      payload: {
        client: "test-v1",
        sig_pubkey: sigKeys.pubKeyB64,
        enc_pubkey: encKeys.pubKeyB64,
      },
    };
    clientSocket.emit("envelope", helloEnvelope);

    // Give gossip time to propagate from A to B
    await wait(500);

    // Server A: user should be in localUsers
    expect(serverA.getLocalUserManager().hasUser(userId)).toBe(true);
    expect(serverA.getLocalUserManager().getLocalUserCount()).toBe(1);

    // Server A: user should be in PresenceManager
    expect(serverA.getPresenceManager().getServerForUser(userId)).toBe(serverA.getServerId());

    // Server B: should have received USER_ADVERTISE gossip
    expect(serverB.getPresenceManager().getServerForUser(userId)).toBe(serverA.getServerId());
  });

  it("USER_REMOVE gossip fires when the client disconnects", async () => {
    const serverA = await startServer(19102);
    const serverB = await startServer(19103, ["127.0.0.1:19102"]);
    servers.push(serverA, serverB);
    await wait(300);

    // Register + connect
    const sigKeys = await genKeyPair();
    const encKeys = await genKeyPair();

    const regRes = await request(serverA.getApp())
      .post("/auth/register")
      .send({
        username: "bob",
        clientHash: "bob-hash",
        enc_pubkey: encKeys.pubKeyB64,
        sig_pubkey: sigKeys.pubKeyB64,
        enc_privkey_store: "blob",
        sig_privkey_store: "blob",
      });
    const { userId } = regRes.body as { userId: string };

    const clientSocket = ioClient("http://127.0.0.1:19102");
    sockets.push(clientSocket);
    await new Promise<void>((r, j) => {
      clientSocket.on("connect", r);
      clientSocket.on("connect_error", j);
    });

    clientSocket.emit("envelope", {
      type: ProtocolMessageType.USER_HELLO,
      from: userId,
      to: serverA.getServerId(),
      ts: Date.now(),
      payload: {
        client: "test-v1",
        sig_pubkey: sigKeys.pubKeyB64,
        enc_pubkey: encKeys.pubKeyB64,
      },
    });

    await wait(400);
    expect(serverB.getPresenceManager().getServerForUser(userId)).toBe(serverA.getServerId());

    // Disconnect the client
    clientSocket.disconnect();
    await wait(400);

    // Both servers should no longer have the user
    expect(serverA.getPresenceManager().getServerForUser(userId)).toBeUndefined();
    expect(serverB.getPresenceManager().getServerForUser(userId)).toBeUndefined();
  });
}, 30000);
