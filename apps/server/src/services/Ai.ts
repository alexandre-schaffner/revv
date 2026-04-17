import { Context, Effect, Layer } from 'effect';
import {
	AiGenerationError,
	AiNotConfiguredError,
	type AiError,
	type ValidationError,
} from '../domain/errors';
import { DbService } from './Db';
import { withDb } from '../effects/with-db';
import { SettingsService } from './Settings';
import type { PrFileMeta } from './GitHub';
import type { WalkthroughStreamEvent } from '@rev/shared';

// ── Prompt & provider imports (split out of this file) ──────────────────────
import { EXPLAIN_SYSTEM_PROMPT, buildExplainPrompt } from '../ai/prompts/explain';
import { checkCliAvailability, streamWalkthroughViaCLI } from '../ai/providers/cli-agent';
import { streamWalkthroughViaMCP, type ContinuationContext } from '../ai/providers/mcp-walkthrough';
import { guardWalkthroughStream } from '../ai/providers/stream-guard';
import { streamViaClaudeCode } from '../ai/providers/claude-code';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExplainParams {
	readonly filePath: string;
	readonly lineRange: [number, number];
	readonly codeSnippet: string;
	readonly fullFileContent: string;
	readonly prTitle: string;
	readonly prBody: string | null;
	readonly diff: string;
}

export type { ContinuationContext };

// ── Agent resolution ────────────────────────────────────────────────────────

export type CliAgent = 'opencode' | 'claude';

/** Safely resolve the configured CLI agent, falling back to 'opencode'. */
export function resolveAgent(settings: { aiAgent: string | null }): CliAgent {
	const agent = settings.aiAgent ?? 'opencode';
	if (agent === 'opencode' || agent === 'claude') return agent;
	return 'opencode';
}

// ── Service definition ───────────────────────────────────────────────────────

export class AiService extends Context.Tag('AiService')<
	AiService,
	{
		readonly explainCode: (
			params: ExplainParams
		) => Effect.Effect<ReadableStream<string>, AiError>;
		readonly streamWalkthrough: (params: {
			pr: { title: string; body: string | null; sourceBranch: string; targetBranch: string; url: string };
			files: PrFileMeta[];
			worktreePath: string;
			continuation?: ContinuationContext;
		}) => Effect.Effect<AsyncGenerator<WalkthroughStreamEvent>, AiError>;
		readonly isConfigured: () => Effect.Effect<boolean>;
	}
>() {}

// ── Live implementation ──────────────────────────────────────────────────────

export const AiServiceLive = Layer.effect(
	AiService,
	Effect.gen(function* () {
		const settingsService = yield* SettingsService;
		const { db } = yield* DbService;

		// Map ValidationError from getSettings() to AiGenerationError
		const getSettings = () =>
			withDb(db, settingsService.getSettings()).pipe(
				Effect.mapError(
					(e: ValidationError) => new AiGenerationError({ cause: e }) as AiError
				)
			);

		// Check if a CLI agent is available
		const checkConfigured = (): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const settings = yield* getSettings();
				const agent = resolveAgent(settings);
				return checkCliAvailability(agent);
			}).pipe(Effect.catchAll(() => Effect.succeed(false)));

		return {
			explainCode: (params: ExplainParams) =>
				Effect.gen(function* () {
					const settings = yield* getSettings();
					const agent = resolveAgent(settings);

					if (!checkCliAvailability(agent)) {
						return yield* Effect.fail(new AiNotConfiguredError());
					}

					const userMessage = buildExplainPrompt(params);
					return streamViaClaudeCode(userMessage, EXPLAIN_SYSTEM_PROMPT);
				}),

			streamWalkthrough: (params) =>
				Effect.gen(function* () {
					const settings = yield* getSettings();
					const agent = resolveAgent(settings);

					if (!checkCliAvailability(agent)) {
						return yield* Effect.fail(new AiNotConfiguredError());
					}

					if (agent === 'opencode') {
						const raw = streamWalkthroughViaCLI(params, settings.aiModel ?? undefined, 'opencode');
						return guardWalkthroughStream(raw, { label: 'opencode', synthesizePhases: true });
					}
					const raw = streamWalkthroughViaMCP(params, settings.aiModel ?? undefined);
					// MCP provider already emits phase events — don't double-emit
					return guardWalkthroughStream(raw, { label: 'mcp', synthesizePhases: false });
				}),

			isConfigured: () => checkConfigured(),
		};
	})
);
