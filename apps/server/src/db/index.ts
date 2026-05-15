import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { serverEnv } from "../config";
import * as schema from "./schema";

export function createDb(path?: string) {
  const dbPath = path ?? serverEnv.dbPath;

  // Ensure the parent directory exists so the DB file (and WAL/SHM sidecars)
  // can be created when dbPath is an absolute path under Application Support, etc.
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrent read performance
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  // Multiple Database handles may open the same file (auth.ts + DbService).
  // Without a busy_timeout SQLite returns SQLITE_BUSY immediately on lock
  // contention, which bun:sqlite surfaces as a "disk I/O error".
  sqlite.run("PRAGMA busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });

  // Run migrations on startup
  // fileURLToPath decodes percent-encoded chars (e.g. %20 from "Application Support")
  // that URL.pathname leaves encoded, which breaks fs.existsSync inside Drizzle's migrator.
  migrate(db, { migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)) });

  return db;
}

export type Db = ReturnType<typeof createDb>;
