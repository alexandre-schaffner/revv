import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { createDb } from "./index";
import { readMigrations, reconcileJournal } from "./journal";
import * as schema from "./schema";

// Every user upgrades from whatever migration their install last ran. These
// tests replay each of those starting points against a DB that holds data,
// then boot through `createDb` exactly like the app does.

const migrationsDirectory = join(import.meta.dir, "migrations");
const journalEntrySchema = z.object({ idx: z.number(), when: z.number(), tag: z.string() });
const journal = z
  .object({ entries: z.array(journalEntrySchema) })
  .parse(JSON.parse(readFileSync(join(migrationsDirectory, "meta", "_journal.json"), "utf8")));

const scratch = mkdtempSync(join(tmpdir(), "revv-migrations-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string | null;
}

function userTables(sqlite: Database): string[] {
  const rows = sqlite
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columnsOf(sqlite: Database, table: string): ColumnInfo[] {
  return sqlite.query(`PRAGMA table_info(\`${table}\`)`).all() as ColumnInfo[];
}

function foreignKeysOf(sqlite: Database, table: string): ForeignKeyInfo[] {
  return sqlite.query(`PRAGMA foreign_key_list(\`${table}\`)`).all() as ForeignKeyInfo[];
}

/**
 * A copy of the DB a fresh install of the build that shipped the first `count`
 * migrations left behind. One in-memory DB advances a migration at a time, so
 * the replay costs no disk I/O; journal `when`s strictly increase
 * (`scripts/check-migrations.ts`), so entry k on top of 1..k-1 runs exactly the
 * SQL a fresh install of that build ran.
 */
const olderBuild = (() => {
  const folder = join(scratch, "journal-prefix");
  mkdirSync(join(folder, "meta"), { recursive: true });
  let sqlite = new Database(":memory:");
  let applied = 0;
  return (count: number): Database => {
    if (count < applied) {
      sqlite.close();
      sqlite = new Database(":memory:");
      applied = 0;
    }
    for (; applied < count; applied++) {
      const entries = journal.entries.slice(0, applied + 1);
      const entry = entries[applied];
      if (!entry) throw new Error(`no journal entry at ${applied}`);
      copyFileSync(join(migrationsDirectory, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
      writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ entries }));
      migrate(drizzle(sqlite), { migrationsFolder: folder });
    }
    return Database.deserialize(sqlite.serialize());
  };
})();

/** Persist an in-memory DB where `createDb` will open it, the way an install's file sits on disk. */
function writeInstall(sqlite: Database, name: string): string {
  const path = join(scratch, `${name}.db`);
  writeFileSync(path, sqlite.serialize());
  sqlite.close();
  return path;
}

function placeholderFor(column: ColumnInfo, table: string): string | number {
  const type = column.type.toUpperCase();
  if (type.includes("INT") || type.includes("REAL") || type.includes("NUM")) return 1;
  // Parents first: a key value doubles as the FK target for children.
  return column.pk > 0 ? `seed-${table}` : "[]";
}

/**
 * One row per table, parents before children, every NOT NULL column filled
 * and every foreign key pointing at the parent's seeded row.
 */
function seedEveryTable(sqlite: Database): string[] {
  const tables = userTables(sqlite);
  const seeded = new Map<string, Map<string, string | number>>();
  const pending = new Set(tables);
  while (pending.size > 0) {
    const ready = [...pending].filter((table) =>
      foreignKeysOf(sqlite, table).every((fk) => fk.table === table || !pending.has(fk.table)),
    );
    expect(ready.length).toBeGreaterThan(0);
    for (const table of ready) {
      pending.delete(table);
      const foreignKeys = foreignKeysOf(sqlite, table);
      const values = new Map<string, string | number>();
      for (const column of columnsOf(sqlite, table)) {
        const fk = foreignKeys.find((key) => key.from === column.name && key.table !== table);
        if (fk) {
          const parent = seeded.get(fk.table);
          const parentValue = parent?.get(fk.to ?? "id") ?? parent?.values().next().value;
          if (parentValue !== undefined) values.set(column.name, parentValue);
          continue;
        }
        if (column.pk > 0 || (column.notnull === 1 && column.dflt_value === null)) {
          values.set(column.name, placeholderFor(column, table));
        }
      }
      const names = [...values.keys()];
      sqlite
        .prepare(
          `INSERT INTO \`${table}\` (${names.map((name) => `\`${name}\``).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        )
        .run(...values.values());
      seeded.set(table, values);
    }
  }
  return tables;
}

function columnNames(sqlite: Database, table: string): string[] {
  return columnsOf(sqlite, table).map((column) => column.name);
}

function indexColumns(sqlite: Database, index: string): string[] {
  const rows = sqlite.query(`PRAGMA index_info(\`${index}\`)`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function whenOf(tag: string): number {
  const entry = journal.entries.find((e) => e.tag === tag);
  if (!entry) throw new Error(`no journal entry ${tag}`);
  return entry.when;
}

/** A DB migrated through `tag` (inclusive), the way an older build left it. */
function migratedThrough(tag: string): Database {
  return olderBuild(journal.entries.findIndex((e) => e.tag === tag) + 1);
}

const migrations = readMigrations(migrationsDirectory);

function rowCount(sqlite: Database, table: string): number {
  const row = sqlite.query(`SELECT COUNT(*) AS n FROM \`${table}\``).get() as { n: number };
  return row.n;
}

function ledgerWhens(sqlite: Database): number[] {
  const rows = sqlite
    .query("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
    .all() as Array<{ created_at: number }>;
  return rows.map((row) => Number(row.created_at));
}

describe("database upgrades", () => {
  it("boots a fresh install into the Drizzle schema", () => {
    const sqlite = createDb(":memory:").$client;
    const drizzleTables = Object.values(schema).flatMap((value) =>
      is(value, SQLiteTable) ? [getTableConfig(value)] : [],
    );

    for (const table of drizzleTables) {
      const actual = new Map(columnsOf(sqlite, table.name).map((column) => [column.name, column]));
      expect({ table: table.name, exists: actual.size > 0 }).toEqual({
        table: table.name,
        exists: true,
      });
      for (const column of table.columns) {
        expect({
          column: `${table.name}.${column.name}`,
          notNull: actual.get(column.name)?.notnull,
        }).toEqual({ column: `${table.name}.${column.name}`, notNull: column.notNull ? 1 : 0 });
      }
      // Leftover columns are tolerated only while inserts can omit them.
      const declared = new Set(table.columns.map((column) => column.name));
      const blocksInserts = [...actual.values()]
        .filter((column) => !declared.has(column.name))
        .filter((column) => column.notnull === 1 && column.dflt_value === null)
        .map((column) => column.name);
      expect({ table: table.name, blocksInserts }).toEqual({
        table: table.name,
        blocksInserts: [],
      });
    }
  });

  // One case per starting point: each install upgrades from wherever its build
  // stopped, and a single case replaying them all grew quadratically. A case
  // takes ~0.2 s, but booting through `createDb` writes and fsyncs a real file,
  // which a contended disk can stall for seconds; bun's 5 s default (what
  // `check:migrations` runs with) is too tight for that.
  const bootTimeoutMs = 20_000;
  const latestWhens = journal.entries.map((entry) => entry.when);
  for (const [index, from] of journal.entries.slice(0, -1).entries()) {
    it(
      `upgrades a populated database from ${from.tag} without losing rows`,
      () => {
        const before = olderBuild(index + 1);
        const tables = seedEveryTable(before);
        const after = createDb(writeInstall(before, `upgrade-${from.tag}`)).$client;

        expect(ledgerWhens(after)).toEqual(latestWhens);
        const survivingTables = new Set(userTables(after));
        for (const table of tables.filter((name) => survivingTables.has(name))) {
          expect({ table, rows: rowCount(after, table) }).toEqual({ table, rows: 1 });
        }
        after.close();
      },
      bootTimeoutMs,
    );
  }

  it("applies a migration that landed behind a newer one instead of skipping it", () => {
    const path = join(scratch, "skipped.db");
    const sqlite = createDb(path).$client;
    const middle = journal.entries.find((entry) => entry.tag === "0370_pr_diff_stats_head");
    expect(middle).toBeDefined();
    // Simulate the migration never having run while a newer one did.
    sqlite.run("ALTER TABLE `pull_requests` DROP COLUMN `diff_stats_head_sha`");
    sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(middle?.when ?? 0);

    reconcileJournal(sqlite, migrations);

    expect(columnNames(sqlite, "pull_requests")).toContain("diff_stats_head_sha");
    expect(ledgerWhens(sqlite)).toEqual(journal.entries.map((entry) => entry.when));
    sqlite.close();
  });

  it("leaves a ledger row with a stale hash alone", () => {
    const path = join(scratch, "stale-hash.db");
    const sqlite = createDb(path).$client;
    sqlite.run(
      "UPDATE __drizzle_migrations SET hash = 'stale' WHERE created_at = (SELECT MIN(created_at) FROM __drizzle_migrations)",
    );

    expect(() => reconcileJournal(sqlite, migrations)).not.toThrow();
    expect(ledgerWhens(sqlite)).toEqual(journal.entries.map((entry) => entry.when));
    sqlite.close();
  });
});

describe("schema applied outside the journal", () => {
  const allWhens = journal.entries.map((entry) => entry.when);

  it("records a migration whose column an older build already added", () => {
    const before = migratedThrough("0200_linked_clones");
    before.run("ALTER TABLE `user_settings` ADD `github_client_id` text DEFAULT '' NOT NULL");

    const after = createDb(writeInstall(before, "ahead-column")).$client;
    expect(ledgerWhens(after)).toEqual(allWhens);
    after.close();
  });

  it("finishes a partly applied migration and the unrecorded ones behind it", () => {
    const before = migratedThrough("0210_github_client_id");
    // Review rounds started landing outside the journal, without the modes.
    before.run("ALTER TABLE `walkthroughs` ADD `mode` text DEFAULT 'reviewer' NOT NULL");
    before.run(
      "ALTER TABLE `walkthroughs` ADD `parent_walkthrough_id` text REFERENCES `walkthroughs`(`id`) ON DELETE set null",
    );

    const after = createDb(writeInstall(before, "partial")).$client;
    expect(ledgerWhens(after)).toEqual(allWhens);
    expect(columnNames(after, "walkthroughs")).toEqual(
      expect.arrayContaining(["mode", "base_head_sha", "generation_mode"]),
    );
    expect(userTables(after)).toContain("review_rounds");
    after.close();
  });

  it("does not resurrect an index a later applied migration dropped", () => {
    const path = join(scratch, "superseded-index.db");
    const sqlite = createDb(path).$client;
    sqlite
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?")
      .run(whenOf("0220_walkthrough_modes"));

    reconcileJournal(sqlite, migrations);

    expect(ledgerWhens(sqlite)).toEqual(allWhens);
    expect(indexColumns(sqlite, "walkthroughs_pr_head_sha_mode_unique")).toEqual([]);
    sqlite.close();
  });

  it("restores what a recorded migration created but the schema lost", () => {
    const path = join(scratch, "drift.db");
    const sqlite = createDb(path).$client;
    sqlite.run("ALTER TABLE `user_settings` DROP COLUMN `github_client_id`");
    sqlite.run("ALTER TABLE `remote_users` DROP COLUMN `avatar_content`");
    sqlite.run("DROP INDEX `chat_sessions_pr_agent_model_sha_unique`");
    sqlite.run(
      "CREATE UNIQUE INDEX `chat_sessions_pr_agent_model_sha_unique` ON `chat_sessions` (`pull_request_id`, `agent`, `pr_head_sha`)",
    );
    sqlite.close();

    const after = createDb(path).$client;
    expect(columnNames(after, "user_settings")).toContain("github_client_id");
    expect(columnNames(after, "remote_users")).toContain("avatar_content");
    expect(indexColumns(after, "chat_sessions_pr_agent_model_sha_unique")).toEqual([
      "pull_request_id",
      "agent",
      "model",
      "pr_head_sha",
    ]);
    after.close();
  });

  it("is a no-op once the journal and schema agree", () => {
    const path = join(scratch, "settled.db");
    createDb(path).$client.close();
    const sqlite = new Database(path);
    const schemaBefore = sqlite.query("SELECT sql FROM sqlite_master ORDER BY name").all();
    reconcileJournal(sqlite, migrations);
    expect(sqlite.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore);
    expect(ledgerWhens(sqlite)).toEqual(allWhens);
    sqlite.close();
  });
});

describe("one review session per pull request (0490)", () => {
  function seedSplitReviews(sqlite: Database): void {
    const run = (sql: string, ...values: Array<string | number | null>) =>
      sqlite.prepare(sql).run(...values);
    const now = "2026-03-01T00:00:00.000Z";
    run(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)",
      "user-1",
      "Alex",
      "alex@example.com",
    );
    run(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
      "account-1",
      "1",
      "github:github.com",
      "user-1",
    );
    run(
      "INSERT INTO repositories (id, owner, name, full_name, added_at, account_id) VALUES (?, ?, ?, ?, ?, ?)",
      "repo-1",
      "acme",
      "web",
      "acme/web",
      now,
      "account-1",
    );
    for (const pr of ["pr-a", "pr-b"]) {
      run(
        `INSERT INTO pull_requests (id, external_id, repository_id, title, author_login, source_branch,
          target_branch, url, created_at, updated_at, fetched_at)
         VALUES (?, 1, 'repo-1', 'PR', 'alex', 'feat', 'main', 'https://example.com', ?, ?, ?)`,
        pr,
        now,
        now,
        now,
      );
    }
    // PR A: a reviewer and an author session, plus an older completed one.
    for (const [id, pr, mode, startedAt, status] of [
      ["session-old", "pr-a", "reviewer", "2026-01-01T00:00:00.000Z", "completed"],
      ["session-reviewer", "pr-a", "reviewer", "2026-02-01T00:00:00.000Z", "active"],
      ["session-author", "pr-a", "author", "2026-02-02T00:00:00.000Z", "active"],
      ["session-b", "pr-b", "reviewer", "2026-02-01T00:00:00.000Z", "active"],
    ] as const) {
      run(
        "INSERT INTO review_sessions (id, pull_request_id, mode, started_at, status) VALUES (?, ?, ?, ?, ?)",
        id,
        pr,
        mode,
        startedAt,
        status,
      );
    }
    const thread = (
      id: string,
      session: string,
      externalCommentId: string | null,
      externalThreadId: string | null,
    ) =>
      run(
        `INSERT INTO comment_threads (id, review_session_id, file_path, start_line, end_line, created_at,
          external_comment_id, external_thread_id)
         VALUES (?, ?, 'src/a.ts', 1, 1, ?, ?, ?)`,
        id,
        session,
        now,
        externalCommentId,
        externalThreadId,
      );
    const message = (id: string, threadId: string, externalId: string | null, createdAt: string) =>
      run(
        `INSERT INTO thread_messages (id, thread_id, author_name, body, created_at, external_id)
         VALUES (?, ?, 'someone', ?, ?, ?)`,
        id,
        threadId,
        `body of ${id}`,
        createdAt,
        externalId,
      );
    // GitHub thread T1: its root landed in the reviewer session, a reply in
    // the author session, where it became a detached thread of its own.
    thread("thread-root", "session-reviewer", "100", "T1");
    message("msg-root", "thread-root", "100", "2026-02-01T10:00:00.000Z");
    thread("thread-detached", "session-author", "105", "T1");
    message("msg-reply", "thread-detached", "105", "2026-02-01T11:00:00.000Z");
    // Drafts written under either lens, and one in the completed session.
    thread("draft-reviewer", "session-reviewer", null, null);
    message("msg-draft-reviewer", "draft-reviewer", null, now);
    thread("draft-author", "session-author", null, null);
    message("msg-draft-author", "draft-author", null, now);
    thread("draft-old", "session-old", null, null);
    message("msg-draft-old", "draft-old", null, now);
    thread("thread-b", "session-b", "200", "T2");
    message("msg-b", "thread-b", "200", now);

    run(
      `INSERT INTO walkthroughs (id, review_session_id, pull_request_id, status, generated_at, model_used, pr_head_sha)
       VALUES ('walkthrough-a', 'session-author', 'pr-a', 'complete', ?, 'test', 'abc')`,
      now,
    );
    run(
      `INSERT INTO review_rounds (id, pull_request_id, review_session_id, walkthrough_id, round_number, to_sha, created_at)
       VALUES ('round-a', 'pr-a', 'session-reviewer', 'walkthrough-a', 1, 'abc', ?)`,
      now,
    );
    for (const [id, session, decision] of [
      ["hunk-old", "session-old", "accepted"],
      ["hunk-author", "session-author", "rejected"],
    ] as const) {
      run(
        `INSERT INTO hunk_decisions (id, review_session_id, file_path, hunk_index, decision, decided_at)
         VALUES (?, ?, 'src/a.ts', 0, ?, ?)`,
        id,
        session,
        decision,
        now,
      );
    }
  }

  function upgraded(name: string): Database {
    const before = migratedThrough("0480_recap_stopped_status");
    seedSplitReviews(before);
    return createDb(writeInstall(before, name)).$client;
  }

  const pairs = (sqlite: Database, sql: string) =>
    (sqlite.query(sql).all() as Array<{ a: string; b: string }>).map((r) => [r.a, r.b]);

  it("merges every PR's sessions into its oldest one, carrying what hangs off them", () => {
    const after = upgraded("split-reviews-merge");

    expect(
      pairs(after, "SELECT id AS a, pull_request_id AS b FROM review_sessions ORDER BY id"),
    ).toEqual([
      ["session-b", "pr-b"],
      ["session-old", "pr-a"],
    ]);
    expect(columnNames(after, "review_sessions")).toEqual(["id", "pull_request_id", "started_at"]);
    expect(
      pairs(after, "SELECT id AS a, review_session_id AS b FROM comment_threads ORDER BY id"),
    ).toEqual([
      ["draft-author", "session-old"],
      ["draft-old", "session-old"],
      ["draft-reviewer", "session-old"],
      ["thread-b", "session-b"],
      ["thread-root", "session-old"],
    ]);
    expect(pairs(after, "SELECT id AS a, review_session_id AS b FROM walkthroughs")).toEqual([
      ["walkthrough-a", "session-old"],
    ]);
    expect(pairs(after, "SELECT id AS a, review_session_id AS b FROM review_rounds")).toEqual([
      ["round-a", "session-old"],
    ]);
    // The retired hunk decisions were unique per session: the kept session's wins.
    expect(pairs(after, "SELECT id AS a, review_session_id AS b FROM hunk_decisions")).toEqual([
      ["hunk-old", "session-old"],
    ]);
    after.close();
  });

  it("joins a GitHub thread split across sessions back into one, losing no message", () => {
    const after = upgraded("split-reviews-thread");

    expect(
      pairs(after, "SELECT id AS a, thread_id AS b FROM thread_messages ORDER BY created_at, id"),
    ).toEqual([
      ["msg-root", "thread-root"],
      ["msg-reply", "thread-root"],
      ["msg-b", "thread-b"],
      ["msg-draft-author", "draft-author"],
      ["msg-draft-old", "draft-old"],
      ["msg-draft-reviewer", "draft-reviewer"],
    ]);
    after.close();
  });

  it("refuses a second session for a pull request", () => {
    const after = upgraded("split-reviews-unique");

    expect(() =>
      after.run(
        "INSERT INTO review_sessions (id, pull_request_id, started_at) VALUES ('again', 'pr-a', 'now')",
      ),
    ).toThrow();
    after.close();
  });
});

describe("which clone folders Revv wrote (0550)", () => {
  it("marks the managed clones Revv finished, was writing, or refused as its own cut-off clone", () => {
    const before = migratedThrough("0540_drop_stack_user_id");
    const run = (sql: string, ...values: Array<string | number | null>) =>
      before.prepare(sql).run(...values);
    run(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-1', 'A', 'a@example.com', 1, 0, 0)",
    );
    run(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('account-1', '1', 'github:github.com', 'user-1', 0, 0)",
    );
    const incomplete = "The clone at that location is incomplete; delete it or choose another.";
    for (const [id, managed, status, path, error] of [
      ["ready", 1, "ready", "/c/ready", null],
      ["cloning", 1, "cloning", "/c/cloning", null],
      ["restarted", 1, "pending", "/c/restarted", "Server restarted during clone"],
      ["cut-off", 1, "error", "/c/cut-off", incomplete],
      [
        "refused",
        1,
        "error",
        "/c/refused",
        "A non-empty directory already exists at that location.",
      ],
      ["linked", 0, "ready", "/c/linked", null],
      ["never-cloned", 1, "pending", null, null],
    ] as const) {
      run(
        `INSERT INTO repositories (id, owner, name, full_name, added_at, account_id, managed, clone_status, clone_path, clone_error)
         VALUES (?, 'acme', ?, ?, 'now', 'account-1', ?, ?, ?, ?)`,
        id,
        id,
        `acme/${id}`,
        managed,
        status,
        path,
        error,
      );
    }
    run(
      `INSERT INTO pull_requests (id, external_id, repository_id, title, author_login, source_branch,
        target_branch, url, created_at, updated_at, fetched_at, review_status)
       VALUES ('pr-1', 1, 'ready', 'PR', 'a', 'feat', 'main', 'https://example.com', 'now', 'now', 'now', 'approved')`,
    );

    const after = createDb(writeInstall(before, "clone-written")).$client;

    const written = after
      .query("SELECT id FROM repositories WHERE revv_wrote_clone = 1 ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(written.map((row) => row.id)).toEqual(["cloning", "cut-off", "ready", "restarted"]);
    expect(columnNames(after, "pull_requests")).not.toContain("review_status");
    expect(rowCount(after, "pull_requests")).toBe(1);
    after.close();
  });
});
