import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "./index";

const scratch = mkdtempSync(join(tmpdir(), "revv-legacy-db-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A pre-release database: an old ledger and one signed-in user. */
function preSquashDb(path: string): Database {
  const sqlite = new Database(path, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text, created_at numeric)",
  );
  sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('old', 1770000000000)");
  sqlite.run(
    "CREATE TABLE user (id text, name text, email text, email_verified integer, image text, github_login text, created_at integer, updated_at integer, onboarded_at integer)",
  );
  sqlite.run(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'Ada', 'ada@example.com', 1, 1, 1)",
  );
  for (const table of ["account", "session", "repositories", "pull_requests"]) {
    sqlite.run(`CREATE TABLE ${table} (id text)`);
  }
  return sqlite;
}

describe("pre-squash database", () => {
  it("rebuilds fresh, keeps the user, and moves the old WAL with the backup", () => {
    const path = join(scratch, "revv.db");
    // A second connection keeps the old WAL alive across the rebuild.
    const holder = preSquashDb(path);
    expect(existsSync(`${path}-wal`)).toBe(true);

    const fresh = createDb(path).$client;

    expect(fresh.query("SELECT id FROM user").all()).toEqual([{ id: "u1" }]);
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(existsSync(`${path}.bak-wal`)).toBe(true);
    expect(existsSync(`${path}.bak-shm`)).toBe(true);
    fresh.close();
    holder.close();
  });
});
