import { Context, Effect, Layer } from 'effect';
import { eq } from 'drizzle-orm';
import type { UserSettings } from '@rev/shared';
import { AUTO_FETCH_DEFAULT_INTERVAL } from '@rev/shared';
import { ValidationError } from '../domain/errors';
import { userSettings } from '../db/schema/index';
import { DbService } from './Db';

const DEFAULT_SETTINGS: UserSettings = {
	id: 'default',
	aiProvider: 'anthropic',
	aiModel: 'claude-sonnet-4-20250514',
	aiApiKeyRef: null,
	theme: 'dark',
	diffViewMode: 'unified',
	autoFetchInterval: AUTO_FETCH_DEFAULT_INTERVAL,
};

function rowToSettings(row: typeof userSettings.$inferSelect): UserSettings {
	return {
		id: row.id,
		aiProvider: row.aiProvider,
		aiModel: row.aiModel,
		aiApiKeyRef: row.aiApiKeyRef ?? null,
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
				theme: DEFAULT_SETTINGS.theme,
				diffViewMode: DEFAULT_SETTINGS.diffViewMode,
				autoFetchInterval: DEFAULT_SETTINGS.autoFetchInterval,
			};
			// Only set aiApiKeyRef when non-null
			if (DEFAULT_SETTINGS.aiApiKeyRef !== null) {
				insertValues.aiApiKeyRef = DEFAULT_SETTINGS.aiApiKeyRef;
			}
			yield* Effect.tryPromise({
				try: () => Promise.resolve(db.insert(userSettings).values(insertValues).run()),
				catch: (e) => new ValidationError({ message: String(e) }),
			});
			return DEFAULT_SETTINGS;
		}),

	updateSettings: (partial) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			// Build the update set, handling null explicitly for exactOptionalPropertyTypes
			const updateSet: Partial<typeof userSettings.$inferInsert> = {};
			if (partial.aiProvider !== undefined) updateSet.aiProvider = partial.aiProvider;
			if (partial.aiModel !== undefined) updateSet.aiModel = partial.aiModel;
			if (partial.theme !== undefined) updateSet.theme = partial.theme;
			if (partial.diffViewMode !== undefined) updateSet.diffViewMode = partial.diffViewMode;
			if (partial.autoFetchInterval !== undefined)
				updateSet.autoFetchInterval = partial.autoFetchInterval;
			// aiApiKeyRef can be set to null (clear) or a string
			if ('aiApiKeyRef' in partial) {
				updateSet.aiApiKeyRef = partial.aiApiKeyRef ?? undefined;
			}
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
