import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { toBase64Url, fromBase64Url, NONCE_TTL_MS } from "@mesh-chat/common";
import { ServerCrypto } from "../crypto/ServerCrypto.js";
import { PasswordService } from "../crypto/PasswordService.js";
import { UserRepository } from "./UserRepository.js";

/**
 * Pending nonce challenge for a user who passed password verification
 * but hasn't completed the cryptographic proof yet.
 */
interface NonceChallenge {
  nonce: string;   // base64url-encoded random bytes
  expiry: number;  // Unix timestamp (ms) when this challenge expires
}

/**
 * Express router that handles user registration and login.
 *
 * Follows the Controller pattern: handles HTTP request/response logic
 * and delegates to UserRepository (DB), PasswordService (hashing),
 * and ServerCrypto (signature verification).
 *
 * Auth flow summary:
 *   Registration: client sends credentials + keys → server stores them
 *   Login step 1: client sends credentials → server returns nonce + key blobs
 *   Login step 2: client signs nonce with decrypted private key → server verifies
 */
export class AuthController {
  readonly router: Router;
  private userRepo: UserRepository;
  private passwordService: PasswordService;

  /**
   * In-memory store for pending nonce challenges.
   * Key: userId, Value: { nonce, expiry }
   *
   * Entries are short-lived (60s TTL) and cleaned up lazily.
   * In a production system you'd use Redis or similar, but
   * in-memory is fine for our learning project scope.
   */
  private pendingNonces: Map<string, NonceChallenge> = new Map();

  constructor(userRepo: UserRepository, passwordService: PasswordService) {
    this.userRepo = userRepo;
    this.passwordService = passwordService;
    this.router = Router();
    this.setupRoutes();
  }

  /**
   * Wires up the three auth endpoints on the Express router.
   * Each route handler is an arrow function to preserve `this` context.
   */
  private setupRoutes(): void {
    this.router.post("/register", this.handleRegister);
    this.router.post("/login", this.handleLogin);
    this.router.post("/login/verify", this.handleLoginVerify);
  }

  /**
   * POST /register
   *
   * Request body:
   *   { username, clientHash, enc_pubkey, sig_pubkey,
   *     enc_privkey_store, sig_privkey_store }
   *
   * 1. Check if username is already taken
   * 2. Generate a UUID v4 for the new user
   * 3. Hash the clientHash with Argon2id (double hash)
   * 4. Store everything in the database
   * 5. Return { userId }
   */
  private handleRegister = async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        username,
        clientHash,
        enc_pubkey,
        sig_pubkey,
        enc_privkey_store,
        sig_privkey_store,
      } = req.body;

      // Validate that all required fields are present
      if (!username || !clientHash || !enc_pubkey || !sig_pubkey
          || !enc_privkey_store || !sig_privkey_store) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      // Check if the username is already registered on this server
      const existing = this.userRepo.findByUsername(username);
      if (existing) {
        res.status(409).json({ error: "Username already taken" });
        return;
      }

      // Generate a unique user ID
      const userId = uuidv4();

      // Double-hash: Argon2id(clientHash)
      // The client already hashed the password with HMAC-SHA256.
      // We hash it again so even a DB leak doesn't expose the client hash.
      const dblHash = await this.passwordService.hash(clientHash);

      // Write the complete user record to the database
      this.userRepo.create({
        user_id: userId,
        username,
        enc_pubkey,
        sig_pubkey,
        enc_privkey_store,
        sig_privkey_store,
        dbl_hash_password: dblHash,
        version: 1,
      });

      res.status(201).json({ userId });
    } catch (err) {
      res.status(500).json({ error: "Registration failed" });
    }
  };

  /**
   * POST /login
   *
   * Request body: { username, clientHash }
   *
   * 1. Look up user by username
   * 2. Verify clientHash against stored Argon2id hash
   * 3. Generate a random nonce and store it with a TTL
   * 4. Return { userId, nonce, enc_privkey_store, sig_privkey_store }
   *
   * The client uses the returned key blobs to decrypt their private
   * keys (with AES-256-GCM using an Argon2id-derived key from their
   * plaintext password), then signs the nonce to prove they hold the
   * private key.
   */
  private handleLogin = async (req: Request, res: Response): Promise<void> => {
    try {
      const { username, clientHash } = req.body;

      if (!username || !clientHash) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      const user = this.userRepo.findByUsername(username);
      if (!user) {
        // Don't reveal whether the username exists or the password is wrong
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Verify: Argon2id(clientHash) == stored dbl_hash_password
      const valid = await this.passwordService.verify(
        clientHash,
        user.dbl_hash_password,
      );
      if (!valid) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Generate a random nonce for the client to sign.
      // 32 bytes of cryptographically secure randomness.
      const nonceBytes = crypto.randomBytes(32);
      const nonce = toBase64Url(new Uint8Array(nonceBytes));

      // Store the nonce with a TTL so it expires if not used promptly
      this.pendingNonces.set(user.user_id, {
        nonce,
        expiry: Date.now() + NONCE_TTL_MS,
      });

      res.status(200).json({
        userId: user.user_id,
        nonce,
        enc_privkey_store: user.enc_privkey_store,
        sig_privkey_store: user.sig_privkey_store,
      });
    } catch (err) {
      res.status(500).json({ error: "Login failed" });
    }
  };

  /**
   * POST /login/verify
   *
   * Request body: { userId, signedNonce }
   *
   * 1. Look up the pending nonce for this user
   * 2. Check it hasn't expired
   * 3. Verify the signature using the user's sig_pubkey
   * 4. If valid, the user is authenticated
   *
   * The signedNonce proves the client successfully decrypted their
   * private signing key (which requires knowing the plaintext password).
   */
  private handleLoginVerify = async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, signedNonce } = req.body;

      if (!userId || !signedNonce) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      // Look up and consume the pending nonce
      const challenge = this.pendingNonces.get(userId);
      if (!challenge) {
        res.status(401).json({ error: "No pending login challenge" });
        return;
      }

      // Remove it immediately so it can't be reused
      this.pendingNonces.delete(userId);

      // Check if the nonce has expired
      if (Date.now() > challenge.expiry) {
        res.status(401).json({ error: "Nonce expired" });
        return;
      }

      // Look up the user's sig_pubkey for verification
      const user = this.userRepo.findById(userId);
      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }

      // Verify: the client signed the nonce bytes with their RSASSA-PSS
      // private key. We verify using their stored public key.
      const nonceBytes = Buffer.from(fromBase64Url(challenge.nonce));
      const valid = ServerCrypto.verify(nonceBytes, signedNonce, user.sig_pubkey);

      if (!valid) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      // Authentication successful
      res.status(200).json({
        userId: user.user_id,
        username: user.username,
        enc_pubkey: user.enc_pubkey,
        sig_pubkey: user.sig_pubkey,
      });
    } catch (err) {
      res.status(500).json({ error: "Verification failed" });
    }
  };
}
