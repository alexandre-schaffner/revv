import { Context, Effect, Layer } from 'effect';
import { eq } from 'drizzle-orm';
import type { AiAgent, ThinkingEffort, UserSettings } from '@revv/shared';
import { AUTO_FETCH_DEFAULT_INTERVAL } from '@revv/shared';
import { ValidationError } from '../domain/errors';
import { userSettings } from '../db/schema/index';
import { DbService } from './Db';

const DEFAULT_SETTINGS: UserSettings = {
	id: 'default',
	aiProvider: 'anthropic',
	aiModel: 'opencode/big-pickle',
	aiThinkingEffort: 'medium',
	aiAgent: 'opencode',
	theme: 'dark',
	diffViewMode: 'unified',
	autoFetchInterval: AUTO_FETCH_DEFAULT_INTERVAL,
};

function rowToSettings(row: typeof userSettings.$inferSelect): UserSettings {
	return {
		id: row.id,
		aiProvider: row.aiProvider,
		aiModel: row.aiModel,
		aiThinkingEffort: (row.aiThinkingEffort as ThinkingEffort) ?? 'medium',
		aiAgent: (row.aiAgent as AiAgent) ?? 'opencode',
		theme: row.theme,
		diffViewMode: row.diffViewMode,
		autoFetchInterval: row.autoFetchInterval,
	};
}

export class SettingsService extends Context.Tag('SettingsService')<
	SettingsService,
	{
		readonly getSettings: () => Effect.Effect<UserSettings, ValidationError, DbService>;
		readonly updateSettings: (
			partial: Partial<Omit<UserSettings, 'id'>>
		) => Effect.Effect<UserSettings, ValidationError, DbService>;
	}
>() {}

export const SettingsServiceLive = Layer.succeed(SettingsService, {
	getSettings: () =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db
				.select()
				.from(userSettings)
				.where(eq(userSettings.id, 'default'))
				.get();
			if (row) return rowToSettings(row);
			// Create default settings if missing
			const insertValues: typeof userSettings.$inferInsert = {
				id: 'default',
				aiProvider: DEFAULT_SETTINGS.aiProvider,
				aiModel: DEFAULT_SETTINGS.aiModel,
				aiThinkingEffort: DEFAULT_SETTINGS.aiThinkingEffort,
				aiAgent: DEFAULT_SETTINGS.aiAgent,
				theme: DEFAULT_SETTINGS.theme,
				diffViewMode: DEFAULT_SETTINGS.diffViewMode,
				autoFetchInterval: DEFAULT_SETTINGS.autoFetchInterval,
			};
			yield* Effect.tryPromise({
				try: () => Promise.resolve(db.insert(userSettings).values(insertValues).run()),
				catch: (e) => new ValidationError({ message: String(e) }),
			});
			return DEFAULT_SETTINGS;
		}),

	updateSettings: (partial) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			// Build the update set
			const updateSet: Partial<typeof userSettings.$inferInsert> = {};
			if (partial.aiProvider !== undefined) updateSet.aiProvider = partial.aiProvider;
			if (partial.aiModel !== undefined) updateSet.aiModel = partial.aiModel;
			if (partial.theme !== undefined) updateSet.theme = partial.theme;
			if (partial.diffViewMode !== undefined) updateSet.diffViewMode = partial.diffViewMode;
			if (partial.autoFetchInterval !== undefined)
				updateSet.autoFetchInterval = partial.autoFetchInterval;
			if (partial.aiThinkingEffort !== undefined)
				updateSet.aiThinkingEffort = partial.aiThinkingEffort;
			if (partial.aiAgent !== undefined) updateSet.aiAgent = partial.aiAgent;
			yield* Effect.tryPromise({
				try: () =>
					Promise.resolve(
						db
							.update(userSettings)
							.set(updateSet)
							.where(eq(userSettings.id, 'default'))
							.run()
					),
				catch: (e) => new ValidationError({ message: String(e) }),
			});
			const row = db
				.select()
				.from(userSettings)
				.where(eq(userSettings.id, 'default'))
				.get();
			if (!row)
				return yield* Effect.fail(
					new ValidationError({ message: 'Settings not found after update' })
				);
			return rowToSettings(row);
		}),
});
