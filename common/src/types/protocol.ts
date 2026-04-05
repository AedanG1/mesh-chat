/**
 * All protocol message types used in server-to-server,
 * server-to-client, and client-to-server communication.
 *
 * Each value is the exact string that appears in the
 * "type" field of a JSON Envelope on the wire.
 */
export enum ProtocolMessageType {
  // Server-to-server
  SERVER_HELLO_JOIN = "SERVER_HELLO_JOIN",
  SERVER_WELCOME = "SERVER_WELCOME",
  SERVER_ANNOUNCE = "SERVER_ANNOUNCE",
  SERVER_DELIVER = "SERVER_DELIVER",
  HEARTBEAT = "HEARTBEAT",

  // User presence (server broadcasts)
  USER_ADVERTISE = "USER_ADVERTISE",
  USER_REMOVE = "USER_REMOVE",

  // User-to-server / server-to-user
  USER_HELLO = "USER_HELLO",
  MSG_DIRECT = "MSG_DIRECT",
  USER_DELIVER = "USER_DELIVER",

  // Control
  CTRL_CLOSE = "CTRL_CLOSE",
  ERROR = "ERROR",
}

/**
 * The universal JSON envelope that wraps every protocol message.
 *
 * - `type`    – one of the ProtocolMessageType values
 * - `from`    – UUID of the sending server or user
 * - `to`      – UUID of recipient server/user, or "*" for broadcast
 * - `ts`      – Unix timestamp in milliseconds
 * - `payload` – message-specific data (see payload interfaces below)
 * - `sig`     – base64url signature over the canonical payload
 */
export interface Envelope {
  type: ProtocolMessageType;
  from: string;
  to: string;
  ts: number;
  payload: Record<string, unknown>;
  sig?: string;
}

// ── Server-to-Server Payloads ────────────────────────────────

/**
 * Base interface for all payload types.
 *
 * Adding `[key: string]: unknown` as an index signature makes every
 * payload interface structurally assignable to `Record<string, unknown>`
 * (the type of Envelope.payload). Without this, TypeScript would require
 * explicit casts at every assignment site.
 *
 * This is safe because:
 *   1. The specific named fields still exist and are still typed
 *   2. The index signature just says "additional unknown keys are allowed"
 *   3. Callers reading known fields get proper types; unknown fields are `unknown`
 */
interface BasePayload {
  [key: string]: unknown;
}

/** Payload for SERVER_HELLO_JOIN: a new server announcing itself to an introducer. */
export interface ServerHelloJoinPayload extends BasePayload {
  host: string;
  port: number;
  sig_pubkey: string; // base64url RSASSA-PSS public key
}

/**
 * Payload for SERVER_WELCOME: introducer's response to SERVER_HELLO_JOIN.
 * Contains the assigned server ID and a snapshot of the entire network state
 * so the joining server can initialize its in-memory tables.
 */
export interface ServerWelcomePayload extends BasePayload {
  assigned_id: string;
  servers: Record<string, { host: string; port: number; sig_pubkey: string }>;
  serverAddrs: Record<string, [string, number]>;
  userLocations: Record<string, string>;
}

/** Payload for SERVER_ANNOUNCE: broadcast after a server joins the network. */
export interface ServerAnnouncePayload extends BasePayload {
  host: string;
  port: number;
  sig_pubkey: string; // base64url RSASSA-PSS public key
}

// ── User Presence Payloads ───────────────────────────────────

/** Payload for USER_ADVERTISE: server tells the network a user is online. */
export interface UserAdvertisePayload extends BasePayload {
  user_id: string;
  server_id: string;
  meta: Record<string, unknown>;
}

/** Payload for USER_REMOVE: server tells the network a user went offline. */
export interface UserRemovePayload extends BasePayload {
  user_id: string;
  server_id: string;
}

// ── User-to-Server Payloads ──────────────────────────────────

/** Payload for USER_HELLO: client announces itself to its local server after login. */
export interface UserHelloPayload extends BasePayload {
  client: string;
  sig_pubkey: string;  // base64url RSASSA-PSS public key (for signature verification)
  enc_pubkey: string;  // base64url RSA-OAEP public key (for encrypting messages to this user)
}

/** Payload for MSG_DIRECT: client sends an E2E-encrypted direct message. */
export interface MsgDirectPayload extends BasePayload {
  ciphertext: string;     // base64url RSA-OAEP(SHA-256) ciphertext (max 446 bytes plaintext)
  sender_sig_pub: string; // base64url RSASSA-PSS public key of sender
  content_sig: string;    // base64url RSASSA-PSS(SHA-256) signature over the ciphertext field
}

// ── Server-to-User / Server-to-Server Delivery Payloads ─────

/** Payload for USER_DELIVER: server delivers an encrypted message to a local client. */
export interface UserDeliverPayload extends BasePayload {
  ciphertext: string;
  sender: string;         // sender's username
  sender_sig_pub: string; // base64url RSASSA-PSS public key
  content_sig: string;    // base64url RSASSA-PSS(SHA-256) signature
}

/** Payload for SERVER_DELIVER: server forwards an encrypted message to another server. */
export interface ServerDeliverPayload extends BasePayload {
  user_id: string;        // recipient user UUID
  ciphertext: string;
  sender: string;         // sender's username
  sender_pub: string;     // base64url RSA-4096 public key
  content_sig: string;    // base64url RSASSA-PSS(SHA-256) signature
}

// ── Control Payloads ─────────────────────────────────────────

/** Payload for ERROR messages. */
export interface ErrorPayload extends BasePayload {
  code: string;    // e.g. "USER_NOT_FOUND"
  message: string; // human-readable description
}
