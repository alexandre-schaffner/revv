import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { auth } from '../auth';
import { AppRuntime } from '../runtime';
import { AiService } from '../services/Ai';
import { PollScheduler } from '../services/PollScheduler';
import { SettingsService } from '../services/Settings';

export const settingsRoutes = new Elysia({ prefix: '/api/settings' })
	.get('/', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		const settings = await AppRuntime.runPromise(
			Effect.flatMap(SettingsService, (s) => s.getSettings())
		);

		// Never expose the raw API key — replace with configured status
		return {
			...settings,
			aiApiKeyRef: settings.aiApiKeyRef ? 'configured' : null,
		};
	})
	.put(
		'/',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

			const updated = await AppRuntime.runPromise(
				Effect.gen(function* () {
					const settingsSvc = yield* SettingsService;
					const scheduler = yield* PollScheduler;
					const result = yield* settingsSvc.updateSettings(ctx.body);

					// Restart poll scheduler if interval changed
					if (ctx.body.autoFetchInterval !== undefined) {
						yield* scheduler.restart(ctx.body.autoFetchInterval);
					}

					return result;
				})
			);

			// Never expose the raw API key
			return {
				...updated,
				aiApiKeyRef: updated.aiApiKeyRef ? 'configured' : null,
			};
		},
		{
			body: t.Partial(
				t.Object({
					aiProvider: t.String(),
					aiModel: t.String(),
					aiApiKeyRef: t.Nullable(t.String()),
					theme: t.String(),
					diffViewMode: t.String(),
					autoFetchInterval: t.Number(),
				})
			),
		}
	)
	.post(
		'/ai-key',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

			try {
				await AppRuntime.runPromise(
					Effect.gen(function* () {
						const ai = yield* AiService;
						const settingsSvc = yield* SettingsService;

						// Validate the key first
						yield* ai.validateKey(ctx.body.apiKey);

						// Store the key
						yield* settingsSvc.updateSettings({ aiApiKeyRef: ctx.body.apiKey });
					})
				);
				return { configured: true };
			} catch (e) {
				if (e && typeof e === 'object' && '_tag' in e) {
					const tagged = e as { _tag: string; message?: string };
					if (tagged._tag === 'AiAuthError') {
						ctx.set.status = 400;
						return { error: 'Invalid API key', configured: false };
					}
					if (tagged._tag === 'AiRateLimitError') {
						ctx.set.status = 429;
						return { error: 'Rate limited — try again later', configured: false };
					}
				}
				ctx.set.status = 500;
				return { error: 'Failed to validate API key', configured: false };
			}
		},
		{
			body: t.Object({
				apiKey: t.String(),
			}),
		}
	)
	.delete('/ai-key', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		await AppRuntime.runPromise(
			Effect.gen(function* () {
				const settingsSvc = yield* SettingsService;
				yield* settingsSvc.updateSettings({ aiApiKeyRef: null });
			})
		);
		return { configured: false };
	})
	.get('/ai-status', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		return AppRuntime.runPromise(
			Effect.gen(function* () {
				const ai = yield* AiService;
				const settingsSvc = yield* SettingsService;
				const configured = yield* ai.isConfigured();
				const keySource = yield* ai.getKeySource();
				const settings = yield* settingsSvc.getSettings();
				return { configured, keySource, model: settings.aiModel };
			})
		);
	});
