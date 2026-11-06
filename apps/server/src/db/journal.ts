import type { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";

// Drizzle's migrator trusts its ledger: it runs only migrations newer than the
// newest ledger row. Two things break that on real installs. A migration that
// lands on `main` behind one users already ran is skipped forever, and builds
// that applied DDL outside the journal leave schema the ledger doesn't know
// about, so the next replay hits "duplicate column". `reconcileJournal` makes
// the ledger and the schema agree before Drizzle runs, using only the
// migration files themselves: no DDL is copied here.

type Artifact =
  | { readonly kind: "table"; readonly table: string; readonly columns: readonly ColumnDef[] }
  | { readonly kind: "column"; readonly table: string; readonly column: ColumnDef }
  | {
      readonly kind: "index";
      readonly index: string;
      readonly table: string;
      readonly columns: readonly string[];
    };

type Removal =
  | { readonly kind: "table"; readonly table: string }
  | { readonly kind: "column"; readonly table: string; readonly column: string }
  | { readonly kind: "index"; readonly index: string };

interface ColumnDef {
  readonly name: string;
  readonly definition: string;
}

interface Statement {
  readonly sql: string;
  readonly creates?: Artifact;
  readonly removes?: Removal;
}

interface Migration {
  readonly when: number;
  readonly hash: string;
  readonly statements: readonly Statement[];
}

const ID = '(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))';

function ident(match: RegExpMatchArray, at: number): string {
  return match[at] ?? match[at + 1] ?? match[at + 2] ?? "";
}

/** Split a chunk on `;` outside quotes, dropping `--` comments. */
function splitStatements(chunk: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i] as string;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
    } else if (ch === "-" && chunk[i + 1] === "-") {
      while (i < chunk.length && chunk[i] !== "\n") i++;
      current += "\n";
    } else if (ch === ";") {
      statements.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Split on commas at parenthesis depth 0, outside quotes. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function columnDef(definition: string): ColumnDef | null {
  const match = definition.match(new RegExp(`^${ID}`));
  if (!match || /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(definition)) return null;
  return { name: ident(match, 1), definition };
}

function identList(list: string): string[] {
  return [...list.matchAll(new RegExp(ID, "g"))].map((m) => ident(m, 1));
}

function classify(sql: string): Statement {
  const flat = sql.replace(/\s+/g, " ");
  let m = flat.match(new RegExp(`^ALTER TABLE ${ID} ADD (?:COLUMN )?(.*)$`, "i"));
  if (m) {
    const column = columnDef(m[4] ?? "");
    return column ? { sql, creates: { kind: "column", table: ident(m, 1), column } } : { sql };
  }
  m = flat.match(new RegExp(`^ALTER TABLE ${ID} DROP (?:COLUMN )?${ID}`, "i"));
  if (m) return { sql, removes: { kind: "column", table: ident(m, 1), column: ident(m, 4) } };
  m = flat.match(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${ID} ?\\((.*)\\)$`, "i"));
  if (m) {
    const columns = splitTopLevel(m[4] ?? "").flatMap((part) => columnDef(part) ?? []);
    return { sql, creates: { kind: "table", table: ident(m, 1), columns } };
  }
  m = flat.match(
    new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${ID} ON ${ID} ?\\(([^)]*)\\)`, "i"),
  );
  if (m) {
    return {
      sql,
      creates: {
        kind: "index",
        index: ident(m, 1),
        table: ident(m, 4),
        columns: identList(m[7] ?? ""),
      },
    };
  }
  m = flat.match(new RegExp(`^DROP INDEX (?:IF EXISTS )?${ID}`, "i"));
  if (m) return { sql, removes: { kind: "index", index: ident(m, 1) } };
  m = flat.match(new RegExp(`^DROP TABLE (?:IF EXISTS )?${ID}`, "i"));
  if (m) return { sql, removes: { kind: "table", table: ident(m, 1) } };
  return { sql };
}

export function readMigrations(migrationsFolder: string): Migration[] {
  return readMigrationFiles({ migrationsFolder }).map((m) => ({
    when: m.folderMillis,
    hash: m.hash,
    statements: m.sql.flatMap(splitStatements).map(classify),
  }));
}

// ── Probes ───────────────────────────────────────────────────────────────────

function tableExists(sqlite: Database, table: string): boolean {
  return (
    sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    null
  );
}

function columnNames(sqlite: Database, table: string): string[] {
  const rows = sqlite.query(`PRAGMA table_info(\`${table}\`)`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexColumns(sqlite: Database, index: string): string[] | null {
  const exists = sqlite
    .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index);
  if (exists === null) return null;
  const rows = sqlite.query(`PRAGMA index_info(\`${index}\`)`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function isPresent(sqlite: Database, artifact: Artifact): boolean {
  switch (artifact.kind) {
    case "table":
      return tableExists(sqlite, artifact.table);
    case "column":
      return columnNames(sqlite, artifact.table).includes(artifact.column.name);
    case "index":
      return indexColumns(sqlite, artifact.index) !== null;
  }
}

function isRemovalDone(sqlite: Database, removal: Removal): boolean {
  switch (removal.kind) {
    case "table":
      return !tableExists(sqlite, removal.table);
    case "column":
      return !columnNames(sqlite, removal.table).includes(removal.column);
    case "index":
      return indexColumns(sqlite, removal.index) === null;
  }
}

/** Whether one of `later` drops `artifact` (an index, a column, or its table). */
function removes(later: readonly Migration[], artifact: Artifact): boolean {
  return later.some((m) =>
    m.statements.some(({ removes: r }) => {
      if (!r) return false;
      if (artifact.kind === "index") return r.kind === "index" && r.index === artifact.index;
      if (r.kind === "table") return r.table === artifact.table;
      return (
        artifact.kind === "column" &&
        r.kind === "column" &&
        r.table === artifact.table &&
        r.column === artifact.column.name
      );
    }),
  );
}

/** A column a CREATE TABLE declared can be added back only if existing rows can take it. */
function addable(column: ColumnDef): boolean {
  const def = column.definition;
  if (/\b(PRIMARY KEY|UNIQUE)\b/i.test(def)) return false;
  return !/\bNOT NULL\b/i.test(def) || /\bDEFAULT\b/i.test(def);
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/** Whether a later migration has undone, or is about to undo, `artifact`. */
type Undone = (artifact: Artifact) => boolean;

/**
 * Run an unrecorded migration, skipping each statement whose effect is already
 * there or that a later migration undid.
 */
function applyIdempotently(sqlite: Database, migration: Migration, undone: Undone): void {
  for (const statement of migration.statements) {
    const { creates, removes: removal } = statement;
    if (creates) {
      if (isPresent(sqlite, creates) || undone(creates)) continue;
      if (creates.kind !== "table" && !tableExists(sqlite, creates.table)) continue;
    }
    if (removal && isRemovalDone(sqlite, removal)) continue;
    sqlite.run(statement.sql);
  }
}

/** Restore what a recorded migration created and no later migration undid. */
function repairDrift(sqlite: Database, migration: Migration, undone: Undone): void {
  for (const { sql, creates } of migration.statements) {
    if (!creates || undone(creates)) continue;
    switch (creates.kind) {
      case "table": {
        if (!tableExists(sqlite, creates.table)) {
          sqlite.run(sql);
          break;
        }
        const existing = columnNames(sqlite, creates.table);
        for (const column of creates.columns) {
          if (existing.includes(column.name) || !addable(column)) continue;
          if (undone({ kind: "column", table: creates.table, column })) continue;
          sqlite.run(`ALTER TABLE \`${creates.table}\` ADD ${column.definition}`);
        }
        break;
      }
      case "column":
        if (tableExists(sqlite, creates.table) && !isPresent(sqlite, creates)) sqlite.run(sql);
        break;
      case "index": {
        if (!tableExists(sqlite, creates.table)) break;
        const columns = indexColumns(sqlite, creates.index);
        if (columns?.join("\0") === creates.columns.join("\0")) break;
        const available = columnNames(sqlite, creates.table);
        if (!creates.columns.every((c) => available.includes(c))) break;
        if (columns) sqlite.run(`DROP INDEX \`${creates.index}\``);
        sqlite.run(sql);
        break;
      }
    }
  }
}

/**
 * Make the Drizzle ledger and the schema agree, so Drizzle's own migrator can
 * take over. A migration counts as applied when its hash or its `when` is in
 * the ledger (older builds recorded stale hashes at the right `when`).
 *
 * Every unrecorded migration up to the newest one that is recorded or whose
 * schema is already present (the frontier) runs now, skipping statements whose
 * effect exists, and is recorded. Every migration up to the frontier then gets
 * back the tables, columns and indexes it created that are missing and that no
 * migration up to the frontier removed.
 * A fresh database (empty ledger) is left to Drizzle.
 */
export function reconcileJournal(sqlite: Database, migrations: readonly Migration[]): void {
  if (!tableExists(sqlite, "__drizzle_migrations")) return;
  const ledger = sqlite.query("SELECT hash, created_at FROM __drizzle_migrations").all() as Array<{
    hash: string;
    created_at: number | string;
  }>;
  if (ledger.length === 0) return;
  const hashes = new Set(ledger.map((row) => row.hash));
  const whens = new Set(ledger.map((row) => Number(row.created_at)));
  const recorded = (m: Migration) => hashes.has(m.hash) || whens.has(m.when);

  let frontier = -1;
  migrations.forEach((migration, i) => {
    const present = migration.statements.some((s) => s.creates && isPresent(sqlite, s.creates));
    if (recorded(migration) || present) frontier = i;
  });

  const record = sqlite.prepare(
    'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
  );
  for (const [i, migration] of migrations.slice(0, frontier + 1).entries()) {
    // Migrations past the frontier are Drizzle's to run, so whatever they drop
    // has to exist until then. An unrecorded migration in range runs below and
    // may still read a column it drops; only a dropped index is never read.
    const later = migrations.slice(i + 1, frontier + 1);
    const ran = later.filter(recorded);
    const undone: Undone = (a) => removes(a.kind === "index" ? later : ran, a);
    if (!recorded(migration)) {
      sqlite.transaction(() => {
        applyIdempotently(sqlite, migration, undone);
        record.run(migration.hash, migration.when);
      })();
      console.warn(`[db] Applied migration ${migration.when} that Drizzle would have skipped`);
    }
    repairDrift(sqlite, migration, undone);
  }
}
