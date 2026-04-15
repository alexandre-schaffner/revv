import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema';

export function createDb(path?: string) {
	const dbPath = path ?? process.env['REV_DB_PATH'] ?? './rev.db';
	const sqlite = new Database(dbPath, { create: true });

	// Enable WAL mode for better concurrent read performance
	sqlite.run('PRAGMA journal_mode = WAL');
	sqlite.run('PRAGMA foreign_keys = ON');

	const db = drizzle(sqlite, { schema });

	// Run migrations on startup
	migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });

	return db;
}

export type Db = ReturnType<typeof createDb>;
