// ── Chat route ─────────────────────────────────────────────────────────────
//
// The right-pane AI chat HTTP surface.
//
//   POST   /api/chat                                - stream a turn (SSE)
//   GET    /api/chat/:prId/messages                 - load persisted timeline
//   GET    /api/chat/:prId/proposed-changes         - list commits the agent made
//   GET    /api/chat/:prId/proposed-changes/:sha/diff - unified diff for one
//   DELETE /api/chat/:prId                          - clear the conversation
//
// Sessions are persisted in `chat_sessions` keyed on (prId, agent, prHeadSha).
// The full transcript (user + assistant messages, structured tool-use rows)
// lives in `chat_messages` and `chat_activities` so it survives desktop
// reloads, daemon restarts, and the agent's own session-storage churn (gap
// A1 + C1 from the gap-analysis roadmap). The agent-side session id is
// still tracked so follow-up turns resume the same provider context.

import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { and, eq, desc } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import { AppRuntime } from '../runtime';
import { AiService, resolveAgent } from '../services/Ai';
import { ChatSessionService } from '../services/ChatSession';
import { DbService } from '../services/Db';
import { withDb } from '../effects/with-db';
import { GitHubService } from '../services/GitHub';
import { PrContextService } from '../services/PrContext';
import { RepoCloneService } from '../services/RepoClone';
import { SettingsService } from '../services/Settings';
import { walkthroughs } from '../db/schema/walkthroughs';
import { walkthroughIssues } from '../db/schema/walkthrough-issues';
import type { Db } from '../db/index';
import {
	withAuth,
	mapErrorToSSEResponse,
	chatStreamToSSE,
	jsonResponse,
	handleAppError,
	unwrapEffectError,
} from './middleware';
import type { ChatStreamFrame } from '../ai/providers/chat-claude';
import type { ChatWalkthroughContext } from '../ai/prompts/chat';
import { logError } from '../logger';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Best-effort fetch of the latest completed walkthrough's summary, risk,
 * sentiment, and issues for a PR. Returns null on any failure or if no
 * complete walkthrough exists. Used only on chat-session creation — the
 * system prompt is embedded once and the agent retains it.
 */
function fetchWalkthroughContext(
	db: Db,
	prId: string,
): ChatWalkthroughContext | null {
	try {
		const wtRow = db
			.select()
			.from(walkthroughs)
			.where(
				and(
					eq(walkthroughs.pullRequestId, prId),
					eq(walkthroughs.status, 'complete'),
				),
			)
			.orderBy(desc(walkthroughs.generatedAt))
			.limit(1)
			.get();
		if (!wtRow) return null;

		const issues = db
			.select()
			.from(walkthroughIssues)
			.where(eq(walkthroughIssues.walkthroughId, wtRow.id))
			.orderBy(walkthroughIssues.order)
			.limit(40)
			.all();

		return {
			summary: wtRow.summary ?? '',
			riskLevel: wtRow.riskLevel ?? 'low',
			sentiment: wtRow.sentiment ?? null,
			issues: issues.map((i) => ({
				severity: i.severity,
				title: i.title,
				description: i.description,
				filePath: i.filePath,
				startLine: i.startLine,
				endLine: i.endLine,
			})),
		};
	} catch (err) {
		logError(
			'chat',
			'walkthrough lookup failed (best-effort):',
			err instanceof Error ? err.message : String(err),
		);
		return null;
	}
}

/**
 * Run a git command in `cwd` and return its stdout. Throws on non-zero exit
 * or timeout. Used by the proposed-changes endpoints — they don't share
 * `runGit` from RepoClone.ts because that one swallows stdout.
 */
function gitStdout(args: string[], cwd: string, timeoutMs = 10_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn('git', args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		});
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
		proc.stderr?.on('data', (c: Buffer) => errChunks.push(c));
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`git ${args[0] ?? ''} timed out`));
		}, timeoutMs);
		proc.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(Buffer.concat(chunks).toString('utf-8'));
			} else {
				reject(
					new Error(
						`git ${args[0] ?? ''} failed: ${Buffer.concat(errChunks).toString('utf-8').trim()}`,
					),
				);
			}
		});
		proc.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

interface ProposedCommit {
	sha: string;
	shortSha: string;
	subject: string;
	committedAt: string;
	files: string[];
}

/**
 * Wrap the provider's frame stream so each frame is persisted to SQLite as
 * it passes through, then re-emitted to the SSE encoder unchanged.
 *
 * Persistence rules:
 *   - text frames: lazily begin the assistant message on the FIRST chunk
 *     (so the assistant row's sequence lands AFTER any preceding activities,
 *     matching the "user → activities → assistant" timeline shape). Each
 *     subsequent chunk appends content via SQL `||`.
 *   - activity frames: insert a chat_activities row immediately, sequence
 *     allocated atomically against chat_sessions.next_sequence.
 *   - stream end (no error): finalize the assistant message if one exists;
 *     if no text frames ever arrived, create a placeholder assistant row
 *     so the timeline always closes the turn (the user may have only
 *     received tool activity).
 *   - stream error: same as success but populates the assistant message's
 *     `error` column with the inline-error chip text.
 *
 * Persistence is best-effort: if a single insert fails the stream still
 * forwards the frame to the client. Logging the failure keeps us honest
 * about partial state without breaking the user's turn.
 */
function wrapStreamWithPersistence(
	source: ReadableStream<ChatStreamFrame>,
	ctx: { chatSessionId: string; turnId: string },
): ReadableStream<ChatStreamFrame> {
	return new ReadableStream<ChatStreamFrame>({
		async start(controller) {
			const reader = source.getReader();
			let assistantMessageId: string | null = null;
			let textStreamed = false;

			const ensureAssistantMessage = async (): Promise<string> => {
				if (assistantMessageId) return assistantMessageId;
				try {
					const { id } = await AppRuntime.runPromise(
						Effect.flatMap(ChatSessionService, (svc) =>
							svc.beginAssistantMessage({
								chatSessionId: ctx.chatSessionId,
								turnId: ctx.turnId,
							}),
						),
					);
					assistantMessageId = id;
				} catch (err) {
					logError(
						'chat',
						'beginAssistantMessage failed:',
						err instanceof Error ? err.message : String(err),
					);
					// Surface a synthetic id so downstream calls don't keep
					// trying. They'll silently no-op against a non-existent
					// row, which we tolerate over crashing the stream.
					assistantMessageId = '';
				}
				return assistantMessageId;
			};

			const finalize = async (errorMessage: string | null): Promise<void> => {
				try {
					if (!assistantMessageId && errorMessage) {
						// Errored before any text arrived — still record an
						// assistant row so the inline-error chip renders on
						// reload.
						await AppRuntime.runPromise(
							Effect.flatMap(ChatSessionService, (svc) =>
								svc.beginAssistantMessage({
									chatSessionId: ctx.chatSessionId,
									turnId: ctx.turnId,
								}),
							).pipe(
								Effect.tap(({ id }) =>
									Effect.flatMap(ChatSessionService, (svc) =>
										svc.finalizeAssistantMessage({
											messageId: id,
											error: errorMessage,
										}),
									),
								),
							),
						);
					} else if (assistantMessageId) {
						await AppRuntime.runPromise(
							Effect.flatMap(ChatSessionService, (svc) =>
								svc.finalizeAssistantMessage({
									messageId: assistantMessageId!,
									error: errorMessage,
								}),
							),
						);
					}
				} catch (err) {
					logError(
						'chat',
						'finalizeAssistantMessage failed:',
						err instanceof Error ? err.message : String(err),
					);
				}
			};

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					if (value.kind === 'text') {
						textStreamed = true;
						const id = await ensureAssistantMessage();
						if (id) {
							try {
								await AppRuntime.runPromise(
									Effect.flatMap(ChatSessionService, (svc) =>
										svc.appendAssistantContent({
											messageId: id,
											chunk: value.data,
										}),
									),
								);
							} catch (err) {
								logError(
									'chat',
									'appendAssistantContent failed:',
									err instanceof Error ? err.message : String(err),
								);
							}
						}
					} else if (value.kind === 'activity') {
						try {
							await AppRuntime.runPromise(
								Effect.flatMap(ChatSessionService, (svc) =>
									svc.appendActivity({
										chatSessionId: ctx.chatSessionId,
										turnId: ctx.turnId,
										activityKind: value.activityKind,
										toolName: value.toolName,
										summary: value.summary,
										payload: value.payload,
									}),
								),
							);
						} catch (err) {
							logError(
								'chat',
								'appendActivity failed:',
								err instanceof Error ? err.message : String(err),
							);
						}
					}

					controller.enqueue(value);
				}

				// Stream ended cleanly. If no text was streamed but the agent
				// did emit activities or completed silently, still close out
				// the turn with a placeholder row so the timeline is
				// well-formed on reload.
				if (!textStreamed && !assistantMessageId) {
					await ensureAssistantMessage();
				}
				await finalize(null);
				controller.close();
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Stream error';
				await finalize(msg);
				controller.error(err);
			}
		},
	});
}

async function listProposedCommits(
	worktreePath: string,
	prHeadSha: string,
): Promise<ProposedCommit[]> {
	const range = `${prHeadSha}..HEAD`;
	const log = await gitStdout(
		[
			'log',
			range,
			// %x09 = tab; we emit one line per commit then a blank line.
			'--pretty=format:%H%x09%s%x09%aI',
		],
		worktreePath,
	);
	const lines = log.split('\n').filter((l) => l.length > 0);
	if (lines.length === 0) return [];

	const commits: ProposedCommit[] = [];
	for (const line of lines) {
		const parts = line.split('\t');
		if (parts.length < 3) continue;
		const [sha, subject, committedAt] = parts as [string, string, string];
		const namesOut = await gitStdout(
			['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
			worktreePath,
		).catch(() => '');
		const files = namesOut.split('\n').filter((f) => f.length > 0);
		commits.push({
			sha,
			shortSha: sha.slice(0, 7),
			subject,
			committedAt,
			files,
		});
	}
	return commits;
}

// ── Route ──────────────────────────────────────────────────────────────────

export const chatRoute = new Elysia()
	.use(withAuth)
	.post(
		'/api/chat',
		async (ctx) => {
			try {
				const prepared = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const ai = yield* AiService;
						const prCtx = yield* PrContextService;
						const settingsService = yield* SettingsService;
						const chatSessions = yield* ChatSessionService;
						const repoClone = yield* RepoCloneService;
						const github = yield* GitHubService;
						const { db } = yield* DbService;

						// Resolve PR + repo + token
						const { pr, repo, token } = yield* prCtx.resolveBasic(
							ctx.body.prId,
							ctx.session.user.id,
						);

						// Resolve current head SHA (fall back to fetching meta)
						let headSha = pr.headSha;
						if (!headSha) {
							const meta = yield* github.getPrMeta(
								repo.fullName,
								pr.externalId,
								token,
							);
							headSha = meta.headSha;
						}

						const settings = yield* withDb(db, settingsService.getSettings()).pipe(
							Effect.orElseSucceed(
								() => ({ aiAgent: 'opencode' }) as { aiAgent: string | null },
							),
						);
						const agent = resolveAgent(settings);

						// Acquire (or refresh) the per-PR worktree. Shared across
						// walkthrough generation and every chat session for this
						// PR. On SHA change, the dir is fast-forwarded in place
						// rather than torn down and recreated. Any chat-agent
						// commits that haven't been pushed yet will be lost on
						// the `git reset --hard` — agents in this codebase push
						// immediately after each commit, so this is acceptable.
						const { worktreePath, branchName } = yield* repoClone.acquirePrWorktree({
							repoId: repo.id,
							prNumber: pr.externalId,
							prHeadSha: headSha,
							githubToken: token,
						});

						// Eagerly create (or look up) the chat_sessions row so
						// chat_messages and chat_activities can FK to it BEFORE
						// the agent emits its session id. The agent-side id
						// arrives mid-stream via onSessionId and is patched in.
						const chatSessionRow = yield* chatSessions.findOrCreate({
							prId: pr.id,
							agent,
							prHeadSha: headSha,
							worktreePath,
							branchName,
						});

						// "Resume" semantics: present only once the agent has
						// emitted a session id on a previous turn. A fresh row
						// (sessionId === null) means we're starting from scratch.
						const resumeSessionId = chatSessionRow.sessionId ?? null;

						// On new session, fetch walkthrough context for the system prompt.
						// On resume, the agent already has it baked into its persisted session.
						const walkthrough = resumeSessionId
							? null
							: fetchWalkthroughContext(db, pr.id);

						// Append the user message immediately so it persists even
						// if the agent process never emits anything (timeout, crash).
						const turnId = crypto.randomUUID();
						yield* chatSessions.appendUserMessage({
							chatSessionId: chatSessionRow.id,
							turnId,
							content: ctx.body.message,
						});

						// Synchronous-by-await: drivers must await this before
						// streaming any user-visible content (opencode) or before
						// closing their stream (claude). That serializes the
						// SQLite write so a follow-up `chatSessions.find()` for
						// the same (prId, agent, headSha) reliably sees the row,
						// preventing the "fresh session on resend" race.
						const onSessionId = async (sid: string): Promise<void> => {
							try {
								await AppRuntime.runPromise(
									chatSessions.setAgentSessionId({
										chatSessionId: chatSessionRow.id,
										sessionId: sid,
										worktreePath,
										branchName,
									}),
								);
							} catch (err) {
								logError(
									'chat',
									'chatSessions.setAgentSessionId failed:',
									err instanceof Error ? err.message : String(err),
								);
							}
						};

						const frameStream = yield* ai.chat({
							pr: {
								title: pr.title,
								body: pr.body,
								sourceBranch: pr.sourceBranch,
								targetBranch: pr.targetBranch,
							},
							walkthrough,
							message: ctx.body.message,
							cwd: worktreePath,
							branchName,
							resumeSessionId,
							onSessionId,
							prId: pr.id,
						});

						return {
							frameStream,
							chatSessionId: chatSessionRow.id,
							turnId,
						};
					}),
				);

				const persistedStream = wrapStreamWithPersistence(
					prepared.frameStream,
					{ chatSessionId: prepared.chatSessionId, turnId: prepared.turnId },
				);

				return new Response(chatStreamToSSE<ChatStreamFrame>(persistedStream), {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
					},
				});
			} catch (e) {
				return mapErrorToSSEResponse(e);
			}
		},
		{
			body: t.Object({
				prId: t.String(),
				message: t.String(),
			}),
		},
	)
	.get(
		'/api/chat/:prId/messages',
		async (ctx) => {
			try {
				const result = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prCtx = yield* PrContextService;
						const chatSessions = yield* ChatSessionService;
						const settingsService = yield* SettingsService;
						const { db } = yield* DbService;

						const { pr } = yield* prCtx.resolveBasic(
							ctx.params.prId,
							ctx.session.user.id,
						);

						const settings = yield* withDb(db, settingsService.getSettings()).pipe(
							Effect.orElseSucceed(
								() => ({ aiAgent: 'opencode' }) as { aiAgent: string | null },
							),
						);
						const agent = resolveAgent(settings);

						if (!pr.headSha) return null;

						// Resolve the chat session for the *current* head SHA
						// only. Older SHAs are dormant — the user has moved on
						// and a fresh PR commit creates a fresh session row.
						const row = yield* chatSessions.find(pr.id, agent, pr.headSha);
						if (!row) return null;

						const timeline = yield* chatSessions.listTimeline(row.id);
						return { row, timeline };
					}),
				);

				if (!result) {
					return jsonResponse(
						{ chatSessionId: null, entries: [] },
						200,
					);
				}

				return jsonResponse(
					{
						chatSessionId: result.row.id,
						entries: result.timeline,
					},
					200,
				);
			} catch (e) {
				const err = unwrapEffectError(e);
				ctx.set.status = 500;
				return {
					error: err instanceof Error ? err.message : 'Internal error',
				};
			}
		},
		{
			params: t.Object({ prId: t.String() }),
		},
	)
	.delete(
		'/api/chat/:prId',
		async (ctx) => {
			try {
				await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prCtx = yield* PrContextService;
						const chatSessions = yield* ChatSessionService;
						const settingsService = yield* SettingsService;
						const { db } = yield* DbService;

						const { pr } = yield* prCtx.resolveBasic(
							ctx.params.prId,
							ctx.session.user.id,
						);

						const settings = yield* withDb(db, settingsService.getSettings()).pipe(
							Effect.orElseSucceed(
								() => ({ aiAgent: 'opencode' }) as { aiAgent: string | null },
							),
						);
						const agent = resolveAgent(settings);

						// Drop every chat-session row for (pr, agent). The
						// per-PR worktree itself stays put — it's shared with
						// walkthrough generation and re-used across chat
						// sessions, refreshed in place on the next acquire.
						yield* chatSessions.clearAllForPr(pr.id, agent);
					}),
				);
				return new Response(null, { status: 204 });
			} catch (e) {
				ctx.set.status = 500;
				return handleAppError(e, ctx);
			}
		},
		{
			params: t.Object({ prId: t.String() }),
		},
	)
	.get(
		'/api/chat/:prId/proposed-changes',
		async (ctx) => {
			try {
				const result = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prCtx = yield* PrContextService;
						const chatSessions = yield* ChatSessionService;
						const settingsService = yield* SettingsService;
						const { db } = yield* DbService;

						const { pr } = yield* prCtx.resolveBasic(
							ctx.params.prId,
							ctx.session.user.id,
						);

						const settings = yield* withDb(db, settingsService.getSettings()).pipe(
							Effect.orElseSucceed(
								() => ({ aiAgent: 'opencode' }) as { aiAgent: string | null },
							),
						);
						const agent = resolveAgent(settings);

						if (!pr.headSha) return null;
						const row = yield* chatSessions.find(pr.id, agent, pr.headSha);
						if (!row) return null;
						return row;
					}),
				);

				if (!result) {
					return jsonResponse(
						{ branchName: null, prHeadSha: null, commits: [] },
						200,
					);
				}

				const commits = await listProposedCommits(
					result.worktreePath,
					result.prHeadSha,
				).catch((err) => {
					logError(
						'chat',
						'listProposedCommits failed:',
						err instanceof Error ? err.message : String(err),
					);
					return [] as ProposedCommit[];
				});

				return jsonResponse(
					{
						branchName: result.branchName,
						prHeadSha: result.prHeadSha,
						commits,
					},
					200,
				);
			} catch (e) {
				const err = unwrapEffectError(e);
				ctx.set.status = 500;
				return {
					error: err instanceof Error ? err.message : 'Internal error',
				};
			}
		},
		{
			params: t.Object({ prId: t.String() }),
		},
	)
	.get(
		'/api/chat/:prId/proposed-changes/:sha/diff',
		async (ctx) => {
			try {
				const result = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prCtx = yield* PrContextService;
						const chatSessions = yield* ChatSessionService;
						const settingsService = yield* SettingsService;
						const { db } = yield* DbService;

						const { pr } = yield* prCtx.resolveBasic(
							ctx.params.prId,
							ctx.session.user.id,
						);

						const settings = yield* withDb(db, settingsService.getSettings()).pipe(
							Effect.orElseSucceed(
								() => ({ aiAgent: 'opencode' }) as { aiAgent: string | null },
							),
						);
						const agent = resolveAgent(settings);

						if (!pr.headSha) return null;
						return yield* chatSessions.find(pr.id, agent, pr.headSha);
					}),
				);

				if (!result) {
					ctx.set.status = 404;
					return { error: 'No active chat session for this PR' };
				}

				// Validate the SHA shape — defense in depth against arg injection.
				if (!/^[0-9a-f]{7,40}$/i.test(ctx.params.sha)) {
					ctx.set.status = 400;
					return { error: 'Invalid commit SHA' };
				}

				const diff = await gitStdout(
					['show', '--patch', '--pretty=format:', ctx.params.sha],
					result.worktreePath,
					15_000,
				);

				return new Response(diff, {
					headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				});
			} catch (e) {
				const err = unwrapEffectError(e);
				ctx.set.status = 500;
				return {
					error: err instanceof Error ? err.message : 'Internal error',
				};
			}
		},
		{
			params: t.Object({ prId: t.String(), sha: t.String() }),
		},
	);
