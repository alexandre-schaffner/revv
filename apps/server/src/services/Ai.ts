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
import type { WalkthroughStreamEvent, CarriedOverIssue } from '@revv/shared';

// ── Prompt & provider imports (split out of this file) ──────────────────────
import { EXPLAIN_SYSTEM_PROMPT, buildExplainPrompt } from '../ai/prompts/explain';
import { checkCliAvailability } from '../ai/providers/cli-agent';
import { streamWalkthroughViaMCP, type ContinuationContext } from '../ai/providers/mcp-walkthrough';
import { streamWalkthroughViaOpencodeMCP } from '../ai/providers/mcp-walkthrough-opencode';
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
			onSessionId?: (sessionId: string) => void;
			carriedOverIssues?: CarriedOverIssue[];
			/**
			 * Optional caller-owned abort controller. When provided, it is
			 * forwarded to the underlying provider so external cancellation
			 * (regenerate, scope close, shutdown) propagates straight into the
			 * Claude Agent SDK turn or the `opencode run` subprocess.
			 */
			abortController?: AbortController;
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

					// `params` already carries the optional `abortController` — both
					// providers accept the same field, so passing the whole object
					// through is the cleanest way to keep the contract identical.
					if (agent === 'opencode') {
						const raw = streamWalkthroughViaOpencodeMCP(params, settings.aiModel ?? undefined);
						return guardWalkthroughStream(raw, { label: 'opencode-mcp', synthesizePhases: false });
					}
					const raw = streamWalkthroughViaMCP(params, settings.aiModel ?? undefined);
					// MCP provider already emits phase events — don't double-emit
					return guardWalkthroughStream(raw, { label: 'claude-mcp', synthesizePhases: false });
				}),

			isConfigured: () => checkConfigured(),
		};
	})
);
