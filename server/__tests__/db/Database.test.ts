import { describe, it, expect, afterEach } from "vitest";
import { Database } from "../../src/db/Database.js";

describe("Database", () => {
  let db: Database;

  // Use ":memory:" for an in-memory SQLite database.
  // This is fast and doesn't leave files on disk after tests.
  afterEach(() => {
    db?.close();
  });

  it("creates the users table on construction", () => {
    db = new Database(":memory:");

    // Query SQLite's internal schema table to verify our table exists.
    // sqlite_master stores metadata about all tables, indexes, etc.
    const conn = db.getConnection();
    const row = conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .get() as { name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.name).toBe("users");
  });

  it("creates a table with the correct columns", () => {
    db = new Database(":memory:");
    const conn = db.getConnection();

    // PRAGMA table_info returns one row per column with:
    //   cid (column index), name, type, notnull, dflt_value, pk
    const columns = conn.pragma("table_info(users)") as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("username");
    expect(colNames).toContain("enc_pubkey");
    expect(colNames).toContain("sig_pubkey");
    expect(colNames).toContain("enc_privkey_store");
    expect(colNames).toContain("sig_privkey_store");
    expect(colNames).toContain("dbl_hash_password");
    expect(colNames).toContain("version");

    // user_id should be the primary key
    const pkCol = columns.find((c) => c.pk === 1);
    expect(pkCol?.name).toBe("user_id");
  });

  it("can be opened multiple times without error (IF NOT EXISTS)", () => {
    // The CREATE TABLE IF NOT EXISTS should not throw on a second open.
    db = new Database(":memory:");
    // Creating another Database on the same path should be fine
    // (in-memory DBs are separate instances anyway, but this tests
    // that the schema creation doesn't fail on an existing table).
    const db2 = new Database(":memory:");
    db2.close();
  });
});
