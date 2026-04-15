import Anthropic from '@anthropic-ai/sdk';
import { Context, Effect, Layer } from 'effect';
import {
	AiAuthError,
	AiGenerationError,
	AiNotConfiguredError,
	AiRateLimitError,
	type AiError,
	type ValidationError,
} from '../domain/errors';
import { DbService } from './Db';
import { SettingsService } from './Settings';

// ── Prompt constants ─────────────────────────────────────────────────────────

const EXPLAIN_SYSTEM_PROMPT = `You are a code review assistant. The reviewer has selected a code range in a pull request diff and wants to understand it.

Provide a clear, concise explanation covering:
1. **What this code does** — functionality in plain language
2. **What changed** — if this is modified code, what's different from before
3. **Dependencies** — what other code this interacts with
4. **Risks** — anything the reviewer should watch for (edge cases, races, security)

Format as markdown. Keep it under 300 words. Use code references with backticks.
Do not repeat the code back — the reviewer can already see it.`;

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

/** Where the active API key comes from */
export type AiKeySource = 'settings' | 'environment' | 'none';

// ── Service definition ───────────────────────────────────────────────────────

export class AiService extends Context.Tag('AiService')<
	AiService,
	{
		readonly explainCode: (
			params: ExplainParams
		) => Effect.Effect<ReadableStream<string>, AiError>;
		readonly isConfigured: () => Effect.Effect<boolean>;
		readonly getKeySource: () => Effect.Effect<AiKeySource>;
		readonly validateKey: (apiKey: string) => Effect.Effect<void, AiError>;
	}
>() {}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildExplainPrompt(params: ExplainParams): string {
	const lines: string[] = [
		`## File: \`${params.filePath}\` (lines ${params.lineRange[0]}–${params.lineRange[1]})`,
		'',
		'### Selected code',
		'```',
		params.codeSnippet,
		'```',
	];

	if (params.diff) {
		lines.push('', '### File diff (unified patch)', '```diff', params.diff, '```');
	}

	if (params.prTitle) {
		lines.push('', `### PR title: ${params.prTitle}`);
	}
	if (params.prBody) {
		lines.push('', '### PR description', params.prBody);
	}

	// Include full file for context, truncated if too large
	if (params.fullFileContent) {
		const fileLines = params.fullFileContent.split('\n');
		const truncated = fileLines.length > 500;
		const content = truncated ? fileLines.slice(0, 500).join('\n') : params.fullFileContent;
		lines.push(
			'',
			`### Full file content${truncated ? ' (truncated to first 500 lines)' : ''}`,
			'```',
			content,
			'```'
		);
	}

	return lines.join('\n');
}

function mapSdkError(err: unknown): AiError {
	if (err instanceof Anthropic.APIError) {
		if (err.status === 401) {
			return new AiAuthError({ message: 'Invalid API key' });
		}
		if (err.status === 429) {
			const retryAfter = Number(err.headers?.['retry-after']) || 30;
			return new AiRateLimitError({ retryAfter });
		}
		return new AiGenerationError({ cause: err });
	}
	return new AiGenerationError({ cause: err });
}

// ── Live implementation ──────────────────────────────────────────────────────

export const AiServiceLive = Layer.effect(
	AiService,
	Effect.gen(function* () {
		const settingsService = yield* SettingsService;
		const { db } = yield* DbService;

		// Helper: provide DbService to effects that require it
		const withDb = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
			Effect.provideService(eff, DbService, { db });

		// Map ValidationError from getSettings() to AiGenerationError
		const getSettings = () =>
			withDb(settingsService.getSettings()).pipe(
				Effect.mapError(
					(e: ValidationError) => new AiGenerationError({ cause: e }) as AiError
				)
			);

		// Resolve API key: saved key in DB takes priority, then env var
		const getApiKey = (): Effect.Effect<string, AiError> =>
			Effect.gen(function* () {
				const settings = yield* getSettings();
				if (settings.aiApiKeyRef) {
					return settings.aiApiKeyRef;
				}
				// Fallback: check ANTHROPIC_API_KEY env var (set by Claude Code, shell, etc.)
				const envKey = process.env['ANTHROPIC_API_KEY'];
				if (envKey) {
					return envKey;
				}
				return yield* Effect.fail(new AiNotConfiguredError());
			});

		const resolveKeySource = (): Effect.Effect<AiKeySource> =>
			Effect.gen(function* () {
				const settings = yield* getSettings();
				if (settings.aiApiKeyRef) return 'settings' as const;
				if (process.env['ANTHROPIC_API_KEY']) return 'environment' as const;
				return 'none' as const;
			}).pipe(Effect.catchAll(() => Effect.succeed('none' as const)));

		return {
			explainCode: (params: ExplainParams) =>
				Effect.gen(function* () {
					const apiKey = yield* getApiKey();
					const settings = yield* getSettings();

					const client = new Anthropic({ apiKey });
					const userMessage = buildExplainPrompt(params);

					// Create a ReadableStream that pipes Claude's streaming response
					return new ReadableStream<string>({
						async start(controller) {
							try {
								const stream = client.messages.stream({
									model: settings.aiModel,
									max_tokens: 1024,
									system: EXPLAIN_SYSTEM_PROMPT,
									messages: [{ role: 'user', content: userMessage }],
								});

								for await (const event of stream) {
									if (
										event.type === 'content_block_delta' &&
										event.delta.type === 'text_delta'
									) {
										controller.enqueue(event.delta.text);
									}
								}
								controller.close();
							} catch (err) {
								controller.error(mapSdkError(err));
							}
						},
					});
				}),

			isConfigured: () =>
				Effect.gen(function* () {
					const source = yield* resolveKeySource();
					return source !== 'none';
				}).pipe(Effect.catchAll(() => Effect.succeed(false))),

			getKeySource: () => resolveKeySource(),

			validateKey: (apiKey: string) =>
				Effect.tryPromise({
					try: async () => {
						const client = new Anthropic({ apiKey });
						// Minimal call to verify the key works
						await client.messages.create({
							model: 'claude-haiku-4-20250414',
							max_tokens: 1,
							messages: [{ role: 'user', content: 'Hi' }],
						});
					},
					catch: (err) => mapSdkError(err),
				}),
		};
	})
);
