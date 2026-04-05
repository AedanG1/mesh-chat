/**
 * A user record as stored in a server's persistent SQLite database.
 * Mirrors the `users` table schema.
 */
export interface UserRecord {
  user_id: string;           // UUID v4
  username: string;
  enc_pubkey: string;        // base64url RSA-OAEP public key
  sig_pubkey: string;        // base64url RSASSA-PSS public key
  enc_privkey_store: string; // base64url AES-256-GCM encrypted private encryption key blob
  sig_privkey_store: string; // base64url AES-256-GCM encrypted private signing key blob
  dbl_hash_password: string; // Argon2id hash of the client's HMAC-SHA256 hash
  version: number;           // bumped on security changes
}

/**
 * Lightweight user metadata gossiped across the network
 * via USER_ADVERTISE messages. Does not contain any secrets.
 */
export interface UserMeta {
  username: string;
  sig_pubkey: string; // base64url RSASSA-PSS public key (for verifying signatures)
  enc_pubkey: string; // base64url RSA-OAEP public key (for encrypting messages to this user)
}
