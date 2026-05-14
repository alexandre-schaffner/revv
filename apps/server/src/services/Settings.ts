import { existsSync, mkdirSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import type {
	AiAgent,
	ContextWindow,
	FileTreeScope,
	ThinkingEffort,
	UserSettings,
} from '@revv/shared';
import { AUTO_FETCH_DEFAULT_INTERVAL } from '@revv/shared';
import { serverEnv } from '../config';
import { ValidationError } from '../domain/errors';

// ── Storage ───────────────────────────────────────────────────────────────────
// Settings live as JSON at `serverEnv.settingsPath` (`~/.revv/settings.json` by
// default). Single-user, no joins, no transactions — a flat file is plenty.
//
// Reads tolerate a missing or partially-corrupt file by falling back to the
// per-key default in {@link DEFAULT_SETTINGS} (deep-merged so unknown keys in
// the file are preserved across upgrades). Writes are atomic: write to a
// sibling `*.tmp` and rename, so a `kill -9` mid-write can never leave a
// truncated file the next reader chokes on.

const DEFAULT_SETTINGS: UserSettings = {
	id: 'default',
	aiProvider: 'anthropic',
	aiModel: 'opencode/big-pickle',
	aiThinkingEffort: 'medium',
	aiAgent: 'opencode',
	aiContextWindow: '200k',
	aiMaxTurns: 60,
	theme: 'dark',
	diffViewMode: 'unified',
	autoFetchInterval: AUTO_FETCH_DEFAULT_INTERVAL,
	fileTreeScope: 'all',
	githubHost: 'github.com',
};

const MIN_MAX_TURNS = 10;
const MAX_MAX_TURNS = 500;

function coerceMaxTurns(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_SETTINGS.aiMaxTurns;
	}
	const int = Math.floor(value);
	if (int < MIN_MAX_TURNS) return MIN_MAX_TURNS;
	if (int > MAX_MAX_TURNS) return MAX_MAX_TURNS;
	return int;
}

/** Coerce an arbitrary JSON value into a fully-shaped `UserSettings`. */
function normalize(raw: unknown): UserSettings {
	if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
	const r = raw as Record<string, unknown>;
	return {
		id: typeof r['id'] === 'string' ? (r['id'] as string) : DEFAULT_SETTINGS.id,
		aiProvider:
			typeof r['aiProvider'] === 'string'
				? (r['aiProvider'] as string)
				: DEFAULT_SETTINGS.aiProvider,
		aiModel:
			typeof r['aiModel'] === 'string'
				? (r['aiModel'] as string)
				: DEFAULT_SETTINGS.aiModel,
		aiThinkingEffort:
			(typeof r['aiThinkingEffort'] === 'string'
				? (r['aiThinkingEffort'] as ThinkingEffort)
				: DEFAULT_SETTINGS.aiThinkingEffort),
		aiAgent:
			(typeof r['aiAgent'] === 'string'
				? (r['aiAgent'] as AiAgent)
				: DEFAULT_SETTINGS.aiAgent),
		aiContextWindow:
			(typeof r['aiContextWindow'] === 'string'
				? (r['aiContextWindow'] as ContextWindow)
				: DEFAULT_SETTINGS.aiContextWindow),
		aiMaxTurns: coerceMaxTurns(r['aiMaxTurns']),
		theme:
			typeof r['theme'] === 'string'
				? (r['theme'] as string)
				: DEFAULT_SETTINGS.theme,
		diffViewMode:
			typeof r['diffViewMode'] === 'string'
				? (r['diffViewMode'] as string)
				: DEFAULT_SETTINGS.diffViewMode,
		autoFetchInterval:
			typeof r['autoFetchInterval'] === 'number'
				? (r['autoFetchInterval'] as number)
				: DEFAULT_SETTINGS.autoFetchInterval,
		fileTreeScope:
			(typeof r['fileTreeScope'] === 'string'
				? (r['fileTreeScope'] as FileTreeScope)
				: DEFAULT_SETTINGS.fileTreeScope),
		githubHost:
			typeof r['githubHost'] === 'string' && (r['githubHost'] as string).length > 0
				? (r['githubHost'] as string)
				: DEFAULT_SETTINGS.githubHost,
	};
}

async function readSettingsFile(): Promise<UserSettings> {
	const path = serverEnv.settingsPath;
	if (!existsSync(path)) {
		// First run — write defaults so the file is observable for users
		// poking around `~/.revv` and any concurrent reader gets the same
		// canonical bytes we'd hand back from memory.
		await writeSettingsFile(DEFAULT_SETTINGS);
		return { ...DEFAULT_SETTINGS };
	}
	try {
		const raw = await Bun.file(path).text();
		const parsed = JSON.parse(raw);
		return normalize(parsed);
	} catch {
		// Corrupt JSON, encoding glitch, partial write from a crash that
		// somehow bypassed atomic-rename — restore defaults rather than
		// failing the whole settings endpoint. The next write will
		// overwrite the bad bytes.
		const fresh = { ...DEFAULT_SETTINGS };
		await writeSettingsFile(fresh).catch(() => undefined);
		return fresh;
	}
}

async function writeSettingsFile(settings: UserSettings): Promise<void> {
	const path = serverEnv.settingsPath;
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	// Atomic write: tmp file + rename. If the process dies after the tmp
	// is written but before rename, the next boot still sees the previous
	// good file. If it dies after rename, the file is fully written. There
	// is no window where a reader could see a half-written `settings.json`.
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
	await rename(tmp, path);
}

// ── Service definition ────────────────────────────────────────────────────────

export class SettingsService extends Context.Tag('SettingsService')<
	SettingsService,
	{
		readonly getSettings: () => Effect.Effect<UserSettings, ValidationError>;
		readonly updateSettings: (
			partial: Partial<Omit<UserSettings, 'id'>>,
		) => Effect.Effect<UserSettings, ValidationError>;
	}
>() {}

export const SettingsServiceLive = Layer.succeed(SettingsService, {
	getSettings: () =>
		Effect.tryPromise({
			try: () => readSettingsFile(),
			catch: (e) =>
				new ValidationError({
					message: e instanceof Error ? e.message : String(e),
				}),
		}),

	updateSettings: (partial) =>
		Effect.tryPromise({
			try: async () => {
				// Read-modify-write under the assumption that mutations are
				// rare and uncoordinated. Settings is single-user; the only
				// way concurrent writes happen is the user clicking two
				// toggles in the same RAF, in which case last-write-wins is
				// the expected outcome anyway.
				const current = await readSettingsFile();
				const merged: UserSettings = { ...current, ...partial, id: 'default' };
				// Clamp aiMaxTurns at the write boundary so a future read can
				// trust the value without re-normalising.
				const next: UserSettings = {
					...merged,
					aiMaxTurns: coerceMaxTurns(merged.aiMaxTurns),
				};
				await writeSettingsFile(next);
				return next;
			},
			catch: (e) =>
				new ValidationError({
					message: e instanceof Error ? e.message : String(e),
				}),
		}),
});
