import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { AppRuntime } from '../runtime';
import { AiService, resolveAgent } from '../services/Ai';
import { PollScheduler } from '../services/PollScheduler';
import { SettingsService } from '../services/Settings';
import { listCliModels } from '../ai/providers/cli-agent';
import { handleAppError } from './middleware';

export const settingsRoutes = new Elysia({ prefix: '/api/settings' })
	.get('/', async (ctx) => {
		try {
			const settings = await AppRuntime.runPromise(
				Effect.flatMap(SettingsService, (s) => s.getSettings())
			);
			return settings;
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})
	.put(
		'/',
		async (ctx) => {
			try {
				const updated = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const settingsSvc = yield* SettingsService;
						const scheduler = yield* PollScheduler;
						const result = yield* settingsSvc.updateSettings(ctx.body);
						if (ctx.body.autoFetchInterval !== undefined) {
							yield* scheduler.restart(ctx.body.autoFetchInterval);
						}
						return result;
					})
				);
				return updated;
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{
			body: t.Partial(
				t.Object({
					aiProvider: t.String(),
					aiModel: t.String(),
					aiThinkingEffort: t.Union([t.Literal('low'), t.Literal('medium'), t.Literal('high')]),
					aiAgent: t.Union([t.Literal('opencode'), t.Literal('claude')]),
					theme: t.String(),
					diffViewMode: t.String(),
					autoFetchInterval: t.Number(),
				})
			),
		}
	)
	.get('/ai-status', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.gen(function* () {
					const ai = yield* AiService;
					const settingsSvc = yield* SettingsService;
					const configured = yield* ai.isConfigured();
					const settings = yield* settingsSvc.getSettings();
					return { configured, model: settings.aiModel, aiAgent: settings.aiAgent };
				})
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})
	.get('/models', async (ctx) => {
		try {
			const settings = await AppRuntime.runPromise(
				Effect.flatMap(SettingsService, (s) => s.getSettings())
			);
			const models = await listCliModels(resolveAgent(settings));
			return { models };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	});
