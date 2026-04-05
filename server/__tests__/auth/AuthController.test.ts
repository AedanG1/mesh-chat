import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { toBase64Url, fromBase64Url } from "@mesh-chat/common";
import { Database } from "../../src/db/Database.js";
import { UserRepository } from "../../src/auth/UserRepository.js";
import { PasswordService } from "../../src/crypto/PasswordService.js";
import { AuthController } from "../../src/auth/AuthController.js";

describe("AuthController", () => {
  let app: express.Express;
  let db: Database;

  // Generate an RSA keypair for the test user (simulates what the client does).
  // We generate this once before all tests since it's slow.
  let userPubKeyB64: string;
  let userPrivateKey: CryptoKey;

  beforeAll(async () => {
    // Generate a test keypair for RSASSA-PSS signatures using WebCrypto.
    // This simulates the client's sig_pubkey / sig_privkey.
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,               // extractable — we need to export the public key
      ["sign", "verify"],
    );
    userPrivateKey = keyPair.privateKey;
    const pubDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    userPubKeyB64 = toBase64Url(new Uint8Array(pubDer));
  });

  // Create a fresh Express app with in-memory DB before each test
  beforeEach(() => {
    db = new Database(":memory:");
    const repo = new UserRepository(db);
    const passwordService = new PasswordService();
    const authController = new AuthController(repo, passwordService);

    app = express();
    app.use(express.json());
    app.use("/auth", authController.router);
  });

  afterEach(() => {
    db.close();
  });

  describe("POST /auth/register", () => {
    it("registers a new user and returns a userId", async () => {
      const res = await request(app)
        .post("/auth/register")
        .send({
          username: "alice",
          clientHash: "fakeclienthash123",
          enc_pubkey: "fake-enc-pub",
          sig_pubkey: userPubKeyB64,
          enc_privkey_store: "fake-enc-priv-blob",
          sig_privkey_store: "fake-sig-priv-blob",
        });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBeDefined();
      expect(typeof res.body.userId).toBe("string");
    });

    it("rejects duplicate usernames with 409", async () => {
      const body = {
        username: "alice",
        clientHash: "hash",
        enc_pubkey: "key",
        sig_pubkey: "key",
        enc_privkey_store: "blob",
        sig_privkey_store: "blob",
      };

      await request(app).post("/auth/register").send(body);
      const res = await request(app).post("/auth/register").send(body);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Username already taken");
    });

    it("rejects missing fields with 400", async () => {
      const res = await request(app)
        .post("/auth/register")
        .send({ username: "alice" }); // missing other fields

      expect(res.status).toBe(400);
    });
  });

  describe("POST /auth/login", () => {
    // Helper: register a user first
    async function registerAlice() {
      await request(app).post("/auth/register").send({
        username: "alice",
        clientHash: "aliceclienthash",
        enc_pubkey: "alice-enc-pub",
        sig_pubkey: userPubKeyB64,
        enc_privkey_store: "alice-enc-priv-blob",
        sig_privkey_store: "alice-sig-priv-blob",
      });
    }

    it("returns nonce and key blobs for valid credentials", async () => {
      await registerAlice();

      const res = await request(app).post("/auth/login").send({
        username: "alice",
        clientHash: "aliceclienthash",
      });

      expect(res.status).toBe(200);
      expect(res.body.userId).toBeDefined();
      expect(res.body.nonce).toBeDefined();
      expect(res.body.enc_privkey_store).toBe("alice-enc-priv-blob");
      expect(res.body.sig_privkey_store).toBe("alice-sig-priv-blob");
    });

    it("rejects unknown username with 401", async () => {
      const res = await request(app).post("/auth/login").send({
        username: "nobody",
        clientHash: "hash",
      });

      expect(res.status).toBe(401);
    });

    it("rejects wrong password with 401", async () => {
      await registerAlice();

      const res = await request(app).post("/auth/login").send({
        username: "alice",
        clientHash: "wronghash",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/login/verify", () => {
    it("completes the full register -> login -> verify flow", async () => {
      // 1. Register
      const regRes = await request(app).post("/auth/register").send({
        username: "alice",
        clientHash: "aliceclienthash",
        enc_pubkey: "alice-enc-pub",
        sig_pubkey: userPubKeyB64,
        enc_privkey_store: "alice-enc-priv-blob",
        sig_privkey_store: "alice-sig-priv-blob",
      });
      expect(regRes.status).toBe(201);

      // 2. Login (get nonce)
      const loginRes = await request(app).post("/auth/login").send({
        username: "alice",
        clientHash: "aliceclienthash",
      });
      expect(loginRes.status).toBe(200);
      const { userId, nonce } = loginRes.body;

      // 3. Sign the nonce with the user's private key (simulates client).
      //    WebCrypto's subtle.sign returns an ArrayBuffer; we wrap it
      //    in Uint8Array and encode to base64url for the wire.
      const nonceBytes = fromBase64Url(nonce);
      const signature = await crypto.subtle.sign(
        { name: "RSA-PSS", saltLength: 32 },
        userPrivateKey,
        nonceBytes,
      );
      const signedNonce = toBase64Url(new Uint8Array(signature));

      // 4. Verify
      const verifyRes = await request(app).post("/auth/login/verify").send({
        userId,
        signedNonce,
      });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.userId).toBe(userId);
      expect(verifyRes.body.username).toBe("alice");
    });

    it("rejects an invalid signature with 401", async () => {
      // Register + login
      await request(app).post("/auth/register").send({
        username: "bob",
        clientHash: "bobhash",
        enc_pubkey: "bob-enc-pub",
        sig_pubkey: userPubKeyB64,
        enc_privkey_store: "blob",
        sig_privkey_store: "blob",
      });

      const loginRes = await request(app).post("/auth/login").send({
        username: "bob",
        clientHash: "bobhash",
      });
      const { userId } = loginRes.body;

      // Send a garbage signature
      const verifyRes = await request(app).post("/auth/login/verify").send({
        userId,
        signedNonce: "totally-invalid-signature",
      });

      expect(verifyRes.status).toBe(401);
    });

    it("rejects a reused nonce (consumed on first attempt)", async () => {
      // Register + login
      await request(app).post("/auth/register").send({
        username: "carol",
        clientHash: "carolhash",
        enc_pubkey: "enc-pub",
        sig_pubkey: userPubKeyB64,
        enc_privkey_store: "blob",
        sig_privkey_store: "blob",
      });

      const loginRes = await request(app).post("/auth/login").send({
        username: "carol",
        clientHash: "carolhash",
      });
      const { userId, nonce } = loginRes.body;

      // First verify attempt (with valid signature)
      const nonceBytes = fromBase64Url(nonce);
      const signature = await crypto.subtle.sign(
        { name: "RSA-PSS", saltLength: 32 },
        userPrivateKey,
        nonceBytes,
      );
      const signedNonce = toBase64Url(new Uint8Array(signature));

      await request(app).post("/auth/login/verify").send({ userId, signedNonce });

      // Second attempt with same nonce -- should fail because it was consumed
      const secondRes = await request(app)
        .post("/auth/login/verify")
        .send({ userId, signedNonce });

      expect(secondRes.status).toBe(401);
      expect(secondRes.body.error).toContain("No pending login challenge");
    });
  });
});
