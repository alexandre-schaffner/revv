import { Context, Effect, Layer } from 'effect';
import {
	AiGenerationError,
	AiNotConfiguredError,
	type AiError,
	type ValidationError,
} from '../domain/errors';
import { ChatMcpTokens } from './ChatMcpTokens';
import { DbService } from './Db';
import { withDb } from '../effects/with-db';
import { SettingsService } from './Settings';
import { OpencodeSupervisor } from './OpencodeSupervisor';
import type { PrFileMeta } from './GitHub';
import type { WalkthroughStreamEvent } from '@revv/shared';
import type { OpencodeProviderDeps } from '../ai/providers/mcp-walkthrough-opencode';

// ── Prompt & provider imports (split out of this file) ──────────────────────
import { checkCliAvailability } from '../ai/providers/cli-agent';
import { streamWalkthroughViaMCP, type ContinuationContext } from '../ai/providers/mcp-walkthrough';
import { streamWalkthroughViaOpencodeMCP } from '../ai/providers/mcp-walkthrough-opencode';
import { guardWalkthroughStream } from '../ai/providers/stream-guard';
import {
	type ChatPrContext,
	type ChatWalkthroughContext,
	buildChatSystemPrompt,
	buildChatUserMessage,
} from '../ai/prompts/chat';
import { type ChatStreamFrame, streamChatViaClaude } from '../ai/providers/chat-claude';
import { streamChatViaOpencode } from '../ai/providers/chat-opencode';

// ── Types ────────────────────────────────────────────────────────────────────

export type { ContinuationContext };

export interface ChatParams {
	readonly pr: ChatPrContext;
	readonly walkthrough: ChatWalkthroughContext | null;
	readonly message: string;
	readonly cwd: string;
	readonly branchName: string;
	readonly resumeSessionId: string | null;
	readonly onSessionId: (id: string) => void;
	readonly prId: string;
	readonly abortController?: AbortController;
}

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
		readonly streamWalkthrough: (params: {
			/**
			 * The deterministic walkthrough id the MCP tool handlers will scope
			 * all writes to. Issued by {@link WalkthroughJobs.startJob} via
			 * `walkthroughService.createPartial` BEFORE the provider is spawned.
			 * The providers inject this into the shared tool-handler context
			 * (doctrine invariant #11 — identity is orchestrator-provided).
			 */
			walkthroughId: string;
			pr: { title: string; body: string | null; sourceBranch: string; targetBranch: string; url: string };
			files: PrFileMeta[];
			worktreePath: string;
			continuation?: ContinuationContext;
			onSessionId?: (sessionId: string) => void;
			/**
			 * Optional caller-owned abort controller. When provided, it is
			 * forwarded to the underlying provider so external cancellation
			 * (regenerate, scope close, shutdown) propagates straight into the
			 * Claude Agent SDK turn or the opencode HTTP session.
			 */
			abortController?: AbortController;
			/**
			 * Optional caller-provided callbacks for minting + clearing the
			 * opencode HTTP-MCP session token. Only consulted when the
			 * resolved agent is 'opencode'; the Claude SDK path ignores them.
			 * WalkthroughJobs supplies these because it owns the session-token
			 * map (in-process, ephemeral per invariant #1). Kept as plain
			 * callbacks so AiService doesn't need a layer dependency on
			 * WalkthroughJobs (that would cycle — WalkthroughJobs depends on
			 * AiService already).
			 */
			issueOpencodeSessionToken?: (walkthroughId: string) => Promise<string>;
			clearOpencodeSessionToken?: (token: string) => Promise<void>;
		}) => Effect.Effect<AsyncGenerator<WalkthroughStreamEvent>, AiError>;
		/**
		 * Stream a single chat turn for the right-pane chat. Resolves the
		 * configured agent, builds the system prompt + user message, and hands
		 * off to the provider. The returned stream emits both text deltas and
		 * tool-use lines so the UI can render the agent's actions inline.
		 *
		 * Session lifecycle (claude `resume:` / opencode session id) is owned
		 * by the caller (the chat route) — this method just wires the
		 * `resumeSessionId` and `onSessionId` callback through.
		 */
		readonly chat: (
			params: ChatParams,
		) => Effect.Effect<ReadableStream<ChatStreamFrame>, AiError>;
		readonly isConfigured: () => Effect.Effect<boolean>;
	}
>() {}

// ── Live implementation ──────────────────────────────────────────────────────

export const AiServiceLive = Layer.effect(
	AiService,
	Effect.gen(function* () {
		const settingsService = yield* SettingsService;
		const { db } = yield* DbService;
		const supervisor = yield* OpencodeSupervisor;
		const chatMcpTokens = yield* ChatMcpTokens;

		// Map ValidationError from getSettings() to AiGenerationError
		const getSettings = () =>
			withDb(db, settingsService.getSettings()).pipe(
				Effect.mapError(
					(e: ValidationError) => new AiGenerationError({ cause: e, message: e.message }) as AiError
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
			streamWalkthrough: (params) =>
				Effect.gen(function* () {
					const settings = yield* getSettings();
					const agent = resolveAgent(settings);

					if (!checkCliAvailability(agent)) {
						return yield* Effect.fail(new AiNotConfiguredError());
					}

					// Both providers receive the same param shape (including
					// walkthroughId + db) and the tool handlers they register
					// are byte-for-byte the same code — doctrine invariant #13
					// (Agent-path parity).
					const providerParams = { ...params, db };

					if (agent === 'opencode') {
						if (
							!params.issueOpencodeSessionToken ||
							!params.clearOpencodeSessionToken
						) {
							return yield* Effect.fail(
								new AiGenerationError({
									cause: new Error(
										'missing opencode session-token callbacks',
									),
									message:
										'opencode provider requires caller-supplied session-token callbacks',
								}),
							);
						}
						const issueToken = params.issueOpencodeSessionToken;
						const clearToken = params.clearOpencodeSessionToken;
						const deps: OpencodeProviderDeps = {
							ensureDaemon: () =>
								Effect.runPromise(supervisor.ensureRunning()),
							jobStarted: () =>
								Effect.runPromise(supervisor.jobStarted()),
							jobEnded: () => Effect.runPromise(supervisor.jobEnded()),
							client: () => Effect.runPromise(supervisor.client()),
							issueSessionToken: (walkthroughId) =>
								issueToken(walkthroughId),
							clearSessionToken: (token) => clearToken(token),
						};
						const raw = streamWalkthroughViaOpencodeMCP(
							{ ...providerParams, deps },
							settings.aiModel ?? undefined,
							settings,
						);
						return guardWalkthroughStream(raw, { label: 'opencode-mcp', synthesizePhases: false });
					}
					const raw = streamWalkthroughViaMCP(
						providerParams,
						settings.aiModel ?? undefined,
						settings,
					);
					return guardWalkthroughStream(raw, { label: 'claude-mcp', synthesizePhases: false });
				}),

			chat: (params: ChatParams) =>
				Effect.gen(function* () {
					const settings = yield* getSettings();
					const agent = resolveAgent(settings);

					if (!checkCliAvailability(agent)) {
						return yield* Effect.fail(new AiNotConfiguredError());
					}

					const systemPrompt = buildChatSystemPrompt({
						pr: params.pr,
						walkthrough: params.walkthrough,
						branchName: params.branchName,
					});
					const message = buildChatUserMessage({ message: params.message });

					if (agent === 'claude') {
						return streamChatViaClaude({
							message,
							systemPrompt,
							resumeSessionId: params.resumeSessionId ?? undefined,
							cwd: params.cwd,
							onSessionId: params.onSessionId,
							abortController: params.abortController,
							model: settings.aiModel ?? undefined,
							db,
							prId: params.prId,
						});
					}

					// opencode path
					const deps = {
						ensureDaemon: () => Effect.runPromise(supervisor.ensureRunning()),
						jobStarted: () => Effect.runPromise(supervisor.jobStarted()),
						jobEnded: () => Effect.runPromise(supervisor.jobEnded()),
						client: () => Effect.runPromise(supervisor.client()),
						issueChatMcpToken: (prId: string) =>
							Effect.runPromise(chatMcpTokens.issue(prId)),
						clearChatMcpToken: (token: string) =>
							Effect.runPromise(chatMcpTokens.clear(token)),
					};
					return streamChatViaOpencode({
						message,
						systemPrompt,
						resumeSessionId: params.resumeSessionId ?? undefined,
						cwd: params.cwd,
						onSessionId: params.onSessionId,
						abortController: params.abortController,
						model: settings.aiModel ?? undefined,
						deps,
						prId: params.prId,
					});
				}),

			isConfigured: () => checkConfigured(),
		};
	})
);
