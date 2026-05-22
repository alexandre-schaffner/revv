import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Replacement for `drizzle-orm/bun-sqlite/migrator`. The drizzle migrator has
// two pitfalls that bit this codebase:
//
//   1. It decides which migrations to apply by comparing each journal entry's
//      `when` timestamp against `MAX(created_at)` in `__drizzle_migrations`.
//      If a new migration is added with a `when` value lower than that
//      watermark, it is silently skipped forever. The journal in this repo
//      has non-monotonic `when` values (see `meta/_journal.json`), so this
//      has already happened once in production.
//
//   2. It runs each statement chunk via `db.run()`, which under Bun's SQLite
//      driver only prepares and executes the FIRST statement in a multi-
//      statement string. Migration files authored with multiple statements
//      between `--> statement-breakpoint` markers therefore drop everything
//      after the first `;` of each chunk.
//
// This migrator:
//   * Identifies applied migrations by file hash, not by timestamp watermark.
//   * Uses `sqlite.exec()` (which executes ALL statements in the buffer) so
//     chunked migrations apply in full.
//   * Wraps each migration in a transaction so a failure can't leave the DB
//     half-migrated.
//
// On-disk schema of `__drizzle_migrations` is unchanged so existing rows
// remain recognized.

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export function customMigrate(sqlite: Database, migrationsFolder: string): MigrateResult {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);

  const appliedHashes = new Set<string>(
    (sqlite.prepare("SELECT hash FROM __drizzle_migrations").all() as Array<{ hash: string }>).map(
      (r) => r.hash,
    ),
  );

  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const insert = sqlite.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );

  const result: MigrateResult = { applied: [], skipped: [] };

  for (const entry of entries) {
    const file = join(migrationsFolder, `${entry.tag}.sql`);
    const content = readFileSync(file, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");

    if (appliedHashes.has(hash)) {
      result.skipped.push(entry.tag);
      continue;
    }

    const chunks = content
      .split("--> statement-breakpoint")
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && !c.split("\n").every((line) => line.trim().startsWith("--")));

    sqlite.exec("BEGIN");
    try {
      for (const chunk of chunks) sqlite.exec(chunk);
      insert.run(hash, entry.when);
      sqlite.exec("COMMIT");
      result.applied.push(entry.tag);
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw new Error(
        `Migration ${entry.tag} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  return result;
}
