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
import { __dbRecoveryTest, createDb } from "./index";
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

/** A migrations folder holding only the first `count` journal entries. */
function migrationPrefix(count: number): string {
  const folder = join(scratch, `prefix-${count}`);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const entries = journal.entries.slice(0, count);
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ entries }));
  for (const entry of entries) {
    copyFileSync(join(migrationsDirectory, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
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

  it("upgrades a populated database from every earlier migration without losing rows", () => {
    const latestWhens = journal.entries.map((entry) => entry.when);

    for (let applied = 1; applied < journal.entries.length; applied++) {
      const path = join(scratch, `upgrade-${applied}.db`);
      const before = new Database(path, { create: true });
      migrate(drizzle(before), { migrationsFolder: migrationPrefix(applied) });
      const tables = seedEveryTable(before);
      before.close();

      const after = createDb(path).$client;
      expect({ from: journal.entries[applied - 1]?.tag, ledger: ledgerWhens(after) }).toEqual({
        from: journal.entries[applied - 1]?.tag,
        ledger: latestWhens,
      });
      const survivingTables = new Set(userTables(after));
      for (const table of tables.filter((name) => survivingTables.has(name))) {
        expect({
          from: journal.entries[applied - 1]?.tag,
          table,
          rows: rowCount(after, table),
        }).toEqual({ from: journal.entries[applied - 1]?.tag, table, rows: 1 });
      }
      after.close();
    }
  });

  it("applies a migration that landed behind a newer one instead of skipping it", () => {
    const path = join(scratch, "skipped.db");
    const sqlite = createDb(path).$client;
    const middle = journal.entries.find((entry) => entry.tag === "0370_pr_diff_stats_head");
    expect(middle).toBeDefined();
    // Simulate the migration never having run while a newer one did.
    sqlite.run("ALTER TABLE `pull_requests` DROP COLUMN `diff_stats_head_sha`");
    sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(middle?.when ?? 0);

    __dbRecoveryTest.applySkippedMigrations(sqlite);

    expect(__dbRecoveryTest.columnExists(sqlite, "pull_requests", "diff_stats_head_sha")).toBe(
      true,
    );
    expect(ledgerWhens(sqlite)).toEqual(journal.entries.map((entry) => entry.when));
    sqlite.close();
  });

  it("leaves a ledger row with a stale hash alone", () => {
    const path = join(scratch, "stale-hash.db");
    const sqlite = createDb(path).$client;
    sqlite.run(
      "UPDATE __drizzle_migrations SET hash = 'stale' WHERE created_at = (SELECT MIN(created_at) FROM __drizzle_migrations)",
    );

    expect(() => __dbRecoveryTest.applySkippedMigrations(sqlite)).not.toThrow();
    expect(ledgerWhens(sqlite)).toEqual(journal.entries.map((entry) => entry.when));
    sqlite.close();
  });
});
