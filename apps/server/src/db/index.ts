import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { serverEnv } from "../config";
import { appDataDir } from "../paths";
import { readMigrations, reconcileJournal } from "./journal";
import { relocateCwdDatabase, setAsidePreSquashDatabase } from "./legacy-upgrades";
import * as schema from "./schema";

// The compiled desktop server embeds this folder at the same relative path
// (`scripts/build-binary.ts`).
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** `path` (tests pass `:memory:`), else `REVV_DB_PATH`, else `<appDataDir>/revv.db`. */
export function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  if (serverEnv.dbPath) return serverEnv.dbPath;
  return join(appDataDir(), "revv.db");
}

/**
 * The DB may hold session bearer tokens, and its WAL/SHM sidecars hold
 * committed-but-uncheckpointed rows, so keep all three owner-only. The 0700
 * app-data dir is the real backstop; `REVV_DB_PATH` may point elsewhere.
 */
function hardenDbFile(dbPath: string): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(file)) chmodSync(file, 0o600);
    } catch {}
  }
}

export function createDb(path?: string) {
  const dbPath = resolveDbPath(path);
  const onDisk = dbPath !== ":memory:";
  if (onDisk) {
    relocateCwdDatabase(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const restorePreSquash = onDisk ? setAsidePreSquashDatabase(dbPath) : null;

  const sqlite = new Database(dbPath, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA busy_timeout = 5000");

  reconcileJournal(sqlite, readMigrations(MIGRATIONS_FOLDER));
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  restorePreSquash?.(sqlite);
  if (onDisk) hardenDbFile(dbPath);
  return db;
}

export type Db = ReturnType<typeof createDb>;
