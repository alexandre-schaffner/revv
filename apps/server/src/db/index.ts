import { Database } from 'bun:sqlite';
import { fileURLToPath } from 'url';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema';
import { serverEnv } from '../config';

export function createDb(path?: string) {
	const dbPath = path ?? serverEnv.dbPath;
	const sqlite = new Database(dbPath, { create: true });

	// Enable WAL mode for better concurrent read performance
	sqlite.run('PRAGMA journal_mode = WAL');
	sqlite.run('PRAGMA foreign_keys = ON');

	const db = drizzle(sqlite, { schema });

	// Run migrations on startup
	// fileURLToPath decodes percent-encoded chars (e.g. %20 from "Application Support")
	// that URL.pathname leaves encoded, which breaks fs.existsSync inside Drizzle's migrator.
	migrate(db, { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) });

	return db;
}

export type Db = ReturnType<typeof createDb>;
