import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { Utils } from "electrobun/bun";
import * as schema from "./schema";

const DB_DIR = Utils.paths.userData;
const DB_PATH = `${DB_DIR}/desktop.db`;

// Ensure userData directory exists before opening database
mkdirSync(DB_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL");

export const db = drizzle(sqlite, { schema, logger: true });
export type DB = typeof db;
