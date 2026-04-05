import BetterSqlite3 from "better-sqlite3";

/**
 * Wraps a better-sqlite3 connection and manages the schema.
 *
 * Each server instance gets its own SQLite database file that
 * persists user registration data (credentials, keys).
 *
 * better-sqlite3 is synchronous -- every call blocks until the
 * disk I/O completes. This is fine for SQLite because:
 *   1. All data is local (no network round trips)
 *   2. The synchronous API is much simpler than async alternatives
 *   3. SQLite operations are fast for our small dataset
 */
export class Database {
  private db: BetterSqlite3.Database;

  /**
   * Opens (or creates) the SQLite database at the given path
   * and ensures the `users` table exists.
   *
   * @param dbPath - File path for the SQLite database.
   *                 Use ":memory:" for in-memory databases (useful in tests).
   */
  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath);

    // WAL (Write-Ahead Logging) mode allows readers and writers to
    // operate concurrently. Without it, a write lock blocks all reads.
    this.db.pragma("journal_mode = WAL");

    this.createTables();
  }

  /**
   * Creates the `users` table if it doesn't already exist.
   *
   * Column breakdown:
   * - user_id:           UUID v4, primary key
   * - username:           Display name, must be unique across this server
   * - enc_pubkey:         RSA-OAEP public key (base64url) for encrypting messages
   * - sig_pubkey:         RSASSA-PSS public key (base64url) for verifying signatures
   * - enc_privkey_store:  AES-256-GCM encrypted private encryption key blob (base64url)
   * - sig_privkey_store:  AES-256-GCM encrypted private signing key blob (base64url)
   * - dbl_hash_password:  Argon2id hash of the client's HMAC-SHA256 password hash
   * - version:            Bumped on security changes (key rotation, password change)
   */
  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id           TEXT PRIMARY KEY,
        username          TEXT NOT NULL UNIQUE,
        enc_pubkey        TEXT NOT NULL,
        sig_pubkey        TEXT NOT NULL,
        enc_privkey_store TEXT NOT NULL,
        sig_privkey_store TEXT NOT NULL,
        dbl_hash_password TEXT NOT NULL,
        version           INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  /**
   * Exposes the underlying better-sqlite3 instance so that
   * repositories can prepare statements and run queries.
   *
   * In a larger project we might abstract this further, but
   * for our scope direct access keeps things simple.
   */
  getConnection(): BetterSqlite3.Database {
    return this.db;
  }

  /** Closes the database connection. Call this on server shutdown. */
  close(): void {
    this.db.close();
  }
}
