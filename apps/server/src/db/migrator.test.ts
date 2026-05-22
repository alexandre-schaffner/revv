import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customMigrate } from "./migrator";

interface MigrationFile {
  tag: string;
  when: number;
  sql: string;
}

function buildMigrationsFolder(files: MigrationFile[]): string {
  const folder = mkdtempSync(join(tmpdir(), "revv-mig-"));
  mkdirSync(join(folder, "meta"));
  const journal = {
    version: "7",
    dialect: "sqlite",
    entries: files.map((f, idx) => ({
      idx,
      version: "6",
      when: f.when,
      tag: f.tag,
      breakpoints: true,
    })),
  };
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  for (const f of files) writeFileSync(join(folder, `${f.tag}.sql`), f.sql);
  return folder;
}

describe("customMigrate", () => {
  test("applies all journal entries on a fresh database", () => {
    const folder = buildMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
      { tag: "0001_add_b", when: 2000, sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);" },
    ]);
    const db = new Database(":memory:");
    const result = customMigrate(db, folder);
    expect(result.applied).toEqual(["0000_init", "0001_add_b"]);
    expect(result.skipped).toEqual([]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("a");
    expect(tables.map((t) => t.name)).toContain("b");
  });

  test("is idempotent across repeated boots", () => {
    const folder = buildMigrationsFolder([
      { tag: "0000_init", when: 1000, sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
    ]);
    const db = new Database(":memory:");
    customMigrate(db, folder);
    const second = customMigrate(db, folder);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0000_init"]);
  });

  test("non-monotonic when timestamps do not silently skip later journal entries", () => {
    // Reproduces the production bug: a migration added later in journal order
    // gets a `when` value lower than an already-applied row's `created_at`.
    // Drizzle's stock migrator would skip it; ours must not.
    const folder = buildMigrationsFolder([
      { tag: "0000_high_when", when: 9000, sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
      { tag: "0001_low_when", when: 1000, sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);" },
    ]);
    const db = new Database(":memory:");
    const result = customMigrate(db, folder);
    expect(result.applied).toEqual(["0000_high_when", "0001_low_when"]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("a");
    expect(tables.map((t) => t.name)).toContain("b");
  });

  test("runs every statement inside a multi-statement chunk", () => {
    // Reproduces 0100_remote_users's chunking bug under drizzle + bun:sqlite.
    // The migrator must execute the second and third statements too.
    const folder = buildMigrationsFolder([
      {
        tag: "0000_multi",
        when: 1000,
        sql: [
          "CREATE TABLE a (id INTEGER PRIMARY KEY);",
          "",
          "ALTER TABLE a ADD col1 TEXT;",
          "",
          "ALTER TABLE a ADD col2 TEXT;",
        ].join("\n"),
      },
    ]);
    const db = new Database(":memory:");
    customMigrate(db, folder);
    const cols = db.prepare("PRAGMA table_info(a)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(["id", "col1", "col2"]);
  });

  test("catches up a partially-recorded database by hash, in journal order", () => {
    // Simulates an upgrade where the first two migrations are already
    // recorded in __drizzle_migrations but the third hasn't been applied.
    const files: MigrationFile[] = [
      { tag: "0000_a", when: 1000, sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
      { tag: "0001_b", when: 2000, sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);" },
      { tag: "0002_c", when: 3000, sql: "CREATE TABLE c (id INTEGER PRIMARY KEY);" },
    ];
    const folder = buildMigrationsFolder(files);
    const db = new Database(":memory:");
    // Apply only the first two, the way an older migrator would have.
    db.exec(files[0]!.sql);
    db.exec(files[1]!.sql);
    db.exec(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
    );
    for (const f of files.slice(0, 2)) {
      const hash = createHash("sha256").update(f.sql).digest("hex");
      db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
        hash,
        f.when,
      );
    }
    const result = customMigrate(db, folder);
    expect(result.applied).toEqual(["0002_c"]);
    expect(result.skipped).toEqual(["0000_a", "0001_b"]);
  });

  test("rolls back a failing migration without recording it", () => {
    const folder = buildMigrationsFolder([
      { tag: "0000_ok", when: 1000, sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
      {
        tag: "0001_bad",
        when: 2000,
        sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);\nCREATE TABLE b (id INTEGER PRIMARY KEY);",
      },
    ]);
    const db = new Database(":memory:");
    expect(() => customMigrate(db, folder)).toThrow(/0001_bad/);
    // First migration is recorded; second isn't.
    const rows = db
      .prepare("SELECT hash FROM __drizzle_migrations")
      .all() as Array<{ hash: string }>;
    expect(rows).toHaveLength(1);
    // First migration's table exists; partial second-migration state was rolled back.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b')")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(["a"]);
  });

  test("treats a comment-only migration file as a no-op but still records it", () => {
    const folder = buildMigrationsFolder([
      { tag: "0000_noop", when: 1000, sql: "-- intentionally empty\n-- still no SQL here\n" },
    ]);
    const db = new Database(":memory:");
    const result = customMigrate(db, folder);
    expect(result.applied).toEqual(["0000_noop"]);
    const rows = db
      .prepare("SELECT hash FROM __drizzle_migrations")
      .all() as Array<{ hash: string }>;
    expect(rows).toHaveLength(1);
  });
});
