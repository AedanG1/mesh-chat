import type { UserRecord } from "@mesh-chat/common";
import type { Database } from "../db/Database.js";

/**
 * Repository for the `users` table in the server's SQLite database.
 *
 * This follows the Repository pattern: it provides a clean interface
 * for data access (create, find) so the rest of the codebase never
 * touches raw SQL. All SQL lives in this one class.
 *
 * Methods use better-sqlite3 prepared statements, which:
 *   1. Compile the SQL once and reuse it (faster for repeated calls)
 *   2. Use parameterized queries (prevents SQL injection attacks)
 */
export class UserRepository {
  private db;

  constructor(database: Database) {
    this.db = database.getConnection();
  }

  /**
   * Insert a new user record into the database.
   *
   * @param record - A complete UserRecord with all fields populated.
   *                 The caller is responsible for generating the UUID
   *                 and hashing the password before calling this.
   * @throws If the username or user_id already exists (UNIQUE constraint).
   */
  create(record: UserRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO users (
        user_id, username, enc_pubkey, sig_pubkey,
        enc_privkey_store, sig_privkey_store,
        dbl_hash_password, version
      ) VALUES (
        :user_id, :username, :enc_pubkey, :sig_pubkey,
        :enc_privkey_store, :sig_privkey_store,
        :dbl_hash_password, :version
      )
    `);

    // Run executes the INSERT. The named parameters (e.g. :user_id)
    // are matched to keys in the record object automatically.
    stmt.run(record);
  }

  /**
   * Look up a user by their display name.
   *
   * @returns The UserRecord if found, or undefined if no user
   *          with that username exists on this server.
   */
  findByUsername(username: string): UserRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM users WHERE username = ?
    `);

    // .get() returns the first matching row, or undefined if none.
    // The ? placeholder is replaced with the username argument.
    return stmt.get(username) as UserRecord | undefined;
  }

  /**
   * Look up a user by their UUID.
   *
   * @returns The UserRecord if found, or undefined.
   */
  findById(userId: string): UserRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM users WHERE user_id = ?
    `);

    return stmt.get(userId) as UserRecord | undefined;
  }
}
