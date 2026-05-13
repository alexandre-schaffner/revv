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
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppRuntime } from '../runtime';
import { AiService, resolveAgent } from '../services/Ai';
import {
	ChatChangesPushService,
	ChatStreamingConflictError,
	ConcurrentPushError,
	DirtyWorktreeError,
	InvalidBranchNameError,
	NoChangesError,
	NoChatSessionError,
	PushRejectedError,
	RefAlreadyExistsError,
	type ResolvePushFrame,
} from '../services/ChatChangesPush';
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
import type {
	ChatHistoryEntry,
	ChatWalkthroughContext,
} from '../ai/prompts/chat';
import { logError } from '../logger';
import { WorktreeBlockedByUnpushedCommits } from '../domain/errors';

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

/**
 * Returns the contents of `<sha>:<path>` or `null` if git fails (typically
 * because the path doesn't exist at that revision — e.g. asking for a
 * newly-added file at the parent commit).
 */
async function gitShowSafe(sha: string, path: string, cwd: string): Promise<string | null> {
	try {
		return await gitStdout(['show', `${sha}:${path}`], cwd, 10_000);
	} catch {
		return null;
	}
}

/**
 * Best-effort git command runner — ignores all errors. Used for cleanup
 * operations like `rebase --abort` where we want to clean up after a
 * failure without risking a secondary error obscuring the first.
 */
async function gitStdoutBestEffort(args: string[], cwd: string): Promise<void> {
	try {
		await gitStdout(args, cwd, 10_000);
	} catch {
		// Intentionally swallowed — best-effort only.
	}
}

/**
 * Rewind a chat worktree back to the PR's head SHA, discarding any unpushed
 * agent commits sitting on top.
 *
 * This is load-bearing for the "clear conversation" flow: if it silently
 * fails, the agent's old commits stay on the local branch and
 * `acquirePrWorktree` preserves them on the next turn (its `merge-base
 * --is-ancestor` check is exit-0, so the descendant tip is kept by design).
 * The user then sees the *exact same SHAs* re-appear in the proposed-changes
 * strip after clearing — which is the bug this helper exists to prevent.
 *
 * Three failure modes are handled defensively:
 *   1. Stale `index.lock` / `HEAD.lock` from a SIGTERM'd agent turn — removed
 *      before reset so it doesn't trip with "Unable to create '.../index.lock'".
 *   2. Mid-merge / mid-rebase state from a SIGKILL'd merge-push — aborted
 *      best-effort so the MERGE_HEAD / rebase-merge dir doesn't poison reset.
 *   3. Detached HEAD (worktree somehow not on the expected branch ref) —
 *      reattach the branch ref to prHeadSha via `update-ref` and re-point
 *      HEAD via `symbolic-ref`, so subsequent `acquirePrWorktree` sees a
 *      clean branch checkout at the right SHA.
 *
 * Post-reset we verify HEAD matches `prHeadSha` and log loudly on mismatch
 * — silent reset failures were the original bug.
 */
async function discardAgentCommits(opts: {
	worktreePath: string;
	branchName: string;
	prHeadSha: string;
}): Promise<void> {
	const { worktreePath, branchName, prHeadSha } = opts;

	// 1. Clear any lock files. A leftover index.lock from an aborted agent
	// turn is the single most common reason `reset --hard` fails on this
	// worktree. The lockfile lives next to the worktree's gitdir, which
	// sits inside the clone path, not the worktree itself — `git rev-parse
	// --git-dir` resolves it.
	let gitDir: string | null = null;
	try {
		gitDir = (await gitStdout(['rev-parse', '--git-dir'], worktreePath, 5_000)).trim();
	} catch (err) {
		logError(
			'chat-clear',
			'rev-parse --git-dir failed (worktree likely corrupt):',
			err instanceof Error ? err.message : String(err),
		);
		return;
	}
	const absoluteGitDir = gitDir.startsWith('/') ? gitDir : join(worktreePath, gitDir);
	for (const lockName of ['index.lock', 'HEAD.lock']) {
		const lockPath = join(absoluteGitDir, lockName);
		try {
			if (existsSync(lockPath)) {
				await rm(lockPath, { force: true });
			}
		} catch (err) {
			logError(
				'chat-clear',
				`failed to clear stale ${lockName}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// 2. Abort any half-finished merge/rebase. Both fail when nothing is in
	// progress — that's fine, we're using the best-effort variant.
	await gitStdoutBestEffort(['merge', '--abort'], worktreePath);
	await gitStdoutBestEffort(['rebase', '--abort'], worktreePath);
	await gitStdoutBestEffort(['cherry-pick', '--abort'], worktreePath);

	// 3. Ensure HEAD points at the branch ref (not a detached commit). If
	// HEAD is detached, `reset --hard` only moves HEAD — the branch ref
	// keeps its old tip, so acquirePrWorktree later reattaches to the old
	// tip via `worktree add`. Pointing HEAD at the branch first means the
	// reset below updates both the working tree and the branch ref atomically.
	try {
		const headRef = (
			await gitStdout(['symbolic-ref', '--quiet', 'HEAD'], worktreePath, 5_000).catch(
				() => '',
			)
		).trim();
		if (headRef !== `refs/heads/${branchName}`) {
			await gitStdoutBestEffort(
				['symbolic-ref', 'HEAD', `refs/heads/${branchName}`],
				worktreePath,
			);
		}
	} catch (err) {
		logError(
			'chat-clear',
			'failed to verify/reattach HEAD:',
			err instanceof Error ? err.message : String(err),
		);
	}

	// 4. The reset itself. This is the load-bearing line — everything above
	// is just clearing obstacles. We log the actual git failure so we can
	// diagnose silent-failure regressions like the one that motivated this
	// helper.
	try {
		await gitStdout(['reset', '--hard', prHeadSha], worktreePath, 30_000);
	} catch (err) {
		logError(
			'chat-clear',
			`reset --hard ${prHeadSha} failed in ${worktreePath}:`,
			err instanceof Error ? err.message : String(err),
		);
		// Fall through to verification — even a failed reset may have
		// partially worked, and we want the log to capture the final state.
	}

	// 5. Drop any untracked files the agent created but never committed.
	// Without this, the next chat session inherits ghost files in the
	// worktree that confuse `git status` and the agent's own context.
	await gitStdoutBestEffort(['clean', '-fd'], worktreePath);

	// 6. Verify. If HEAD didn't end up at prHeadSha the next chat turn
	// will reproduce the original bug (same SHAs reappear) — emit a loud
	// log so the regression is visible without strace-level debugging.
	try {
		const finalSha = (await gitStdout(['rev-parse', 'HEAD'], worktreePath, 5_000)).trim();
		if (finalSha !== prHeadSha) {
			logError(
				'chat-clear',
				`worktree rewind did not land at prHeadSha. ` +
					`expected=${prHeadSha} got=${finalSha} worktree=${worktreePath}`,
			);
		}
	} catch (err) {
		logError(
			'chat-clear',
			'post-reset HEAD verification failed:',
			err instanceof Error ? err.message : String(err),
		);
	}
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
						const chatPush = yield* ChatChangesPushService;
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

						// Check for an existing session BEFORE acquiring the
						// worktree. No row means this is a fresh start (e.g.
						// the user just cleared chat), so after we acquire the
						// worktree we must hard-reset it — stale agent commits
						// may have survived the clear if the reset raced with
						// this new message.
						const existingSessionRow = yield* chatSessions.find(
							pr.id,
							agent,
							headSha,
						);
						const isFreshStart = existingSessionRow === null;

						// Acquire (or refresh) the per-PR worktree. Shared across
						// walkthrough generation and every chat session for this
						// PR. If HEAD is a descendant of `prHeadSha` — i.e. the
						// agent has committed on top in a previous turn but not
						// pushed — those commits are preserved (the chat-header
						// push pill renders against them). HEAD is only reset
						// when its base diverges from `prHeadSha`, e.g. the PR
						// head moved on the remote.
						const { worktreePath, branchName } = yield* repoClone.acquirePrWorktree({
							repoId: repo.id,
							prNumber: pr.externalId,
							prHeadSha: headSha,
							githubToken: token,
						});

					// Fresh start: hard-reset the worktree to `prHeadSha`
					// so any stale agent commits that survived the clear
					// (due to a race between discardAgentCommits and this
					// handler) are unconditionally removed.
					if (isFreshStart) {
						yield* Effect.promise(() =>
							discardAgentCommits({
								worktreePath,
								branchName,
								prHeadSha: headSha,
							}),
						);
					}

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

						// Snapshot the prior transcript BEFORE appending the new
						// user message so the agent's history block doesn't end
						// with a duplicate of the message it's about to receive.
						const priorTimeline = yield* chatSessions.listTimeline(
							chatSessionRow.id,
						);
						const history: ChatHistoryEntry[] = priorTimeline.map((e) =>
							e.entryKind === 'message'
								? {
										entryKind: 'message',
										role: e.role,
										content: e.content,
									}
								: {
										entryKind: 'activity',
										activityKind: e.activityKind,
										toolName: e.toolName,
										summary: e.summary,
									},
						);

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
							history,
							cwd: worktreePath,
							branchName,
							resumeSessionId,
							onSessionId,
							prId: pr.id,
						});

						// Mark this PR as streaming so a concurrent push attempt
						// is refused (the agent might write to the worktree at
						// any moment, which would race with the push's
						// `git checkout` / `git merge`).
						chatPush.markChatStreaming(pr.id, true);

						return {
							frameStream,
							chatSessionId: chatSessionRow.id,
							turnId,
							prId: pr.id,
						};
					}),
				);

				const persistedStream = wrapStreamWithPersistence(
					prepared.frameStream,
					{ chatSessionId: prepared.chatSessionId, turnId: prepared.turnId },
				);

				// Wrap the persisted stream so we clear the streaming flag
				// when the SSE consumer finishes — success, error, or client
				// disconnect.
				const streamingPrId = prepared.prId;
				const flagClearingStream = new ReadableStream<ChatStreamFrame>({
					async start(controller) {
						const reader = persistedStream.getReader();
						try {
							while (true) {
								const { done, value } = await reader.read();
								if (done) break;
								controller.enqueue(value);
							}
							controller.close();
						} catch (err) {
							controller.error(err);
						} finally {
							try {
								await AppRuntime.runPromise(
									Effect.flatMap(ChatChangesPushService, (svc) =>
										Effect.sync(() =>
											svc.markChatStreaming(streamingPrId, false),
										),
									),
								);
							} catch {
								/* never throw from streaming-flag cleanup */
							}
						}
					},
				});

			return new Response(chatStreamToSSE<ChatStreamFrame>(flagClearingStream), {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
				},
			});
		} catch (e) {
			// Special case: worktree is blocked by unpushed agent commits.
			// Return a structured JSON 409 so the client can show the
			// blocked-commits UI instead of treating it as a generic error.
			const blockedErr = unwrapEffectError(e);
			if (blockedErr instanceof WorktreeBlockedByUnpushedCommits) {
				ctx.set.status = 409;
				return {
					code: 'WORKTREE_BLOCKED',
					message: 'PR head advanced but worktree has unpushed agent commits',
					worktreePath: blockedErr.worktreePath,
					branchName: blockedErr.branchName,
					oldHeadSha: blockedErr.oldHeadSha,
					newHeadSha: blockedErr.newHeadSha,
					commits: blockedErr.commits,
				};
			}
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
				const latest = await AppRuntime.runPromise(
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

						// Capture the active worktree before dropping rows so we
						// can rewind it to the PR head SHA below — clearing the
						// conversation also discards any unpushed agent commits
						// the user accumulated during this session.
						const activeRow = yield* chatSessions.findLatestForPr(pr.id, agent);

						// Drop every chat-session row for (pr, agent). The
						// per-PR worktree itself stays put — it's shared with
						// walkthrough generation and re-used across chat
						// sessions, refreshed in place on the next acquire.
						yield* chatSessions.clearAllForPr(pr.id, agent);

						return activeRow;
					}),
				);

				if (latest && existsSync(latest.worktreePath)) {
					await discardAgentCommits({
						worktreePath: latest.worktreePath,
						branchName: latest.branchName,
						prHeadSha: latest.prHeadSha,
					});
				}

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
	)
	.get(
		'/api/chat/:prId/proposed-changes/:sha/files',
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

				if (!/^[0-9a-f]{7,40}$/i.test(ctx.params.sha)) {
					ctx.set.status = 400;
					return { error: 'Invalid commit SHA' };
				}

				// `-z -M --name-status` outputs one record per changed file as
				// `<status>\0<path>` (or `R<sim>\0<oldPath>\0<newPath>` for renames),
				// records concatenated with no separator.
				const raw = await gitStdout(
					[
						'diff-tree',
						'--no-commit-id',
						'--name-status',
						'-r',
						'-z',
						'-M',
						ctx.params.sha,
					],
					result.worktreePath,
					15_000,
				);

				const tokens = raw.split('\0').filter((t) => t.length > 0);
				const fileTasks: Array<Promise<{
					path: string;
					oldPath: string | null;
					oldContent: string | null;
					newContent: string | null;
					status: string;
					binary: boolean;
				}>> = [];

				for (let i = 0; i < tokens.length; ) {
					const status = tokens[i++];
					if (status == null) break;
					const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
					const oldPath = isRenameOrCopy ? tokens[i++] ?? null : null;
					const path = tokens[i++];
					if (path == null) break;

					const isAdd = status === 'A';
					const isDel = status === 'D';
					const oldRef = isAdd ? null : oldPath ?? path;
					const newRef = isDel ? null : path;

					fileTasks.push(
						(async () => {
							const [oldRaw, newRaw] = await Promise.all([
								oldRef
									? gitShowSafe(`${ctx.params.sha}^`, oldRef, result.worktreePath)
									: Promise.resolve(null),
								newRef
									? gitShowSafe(ctx.params.sha, newRef, result.worktreePath)
									: Promise.resolve(null),
							]);
							// Cheap binary heuristic: a null byte anywhere in either
							// version. Good enough for the typical mix of text + images
							// the agent produces; binary files just render as a
							// no-content placeholder on the client.
							const binary =
								(oldRaw != null && oldRaw.includes('\0')) ||
								(newRaw != null && newRaw.includes('\0'));
							return {
								path,
								oldPath,
								status,
								oldContent: binary ? null : oldRaw,
								newContent: binary ? null : newRaw,
								binary,
							};
						})(),
					);
				}

				const files = await Promise.all(fileTasks);
				return { files };
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
	)
	.post(
		'/api/chat/:prId/proposed-changes/merge-and-push',
		async (ctx) => {
			try {
				const body = (ctx.body ?? {}) as {
					newBranchName?: unknown;
					force?: unknown;
				};
				let newBranchName: string | undefined;
				if (body.newBranchName !== undefined) {
					if (typeof body.newBranchName !== 'string') {
						ctx.set.status = 400;
						return {
							code: 'INVALID_BRANCH_NAME',
							message: 'newBranchName must be a string',
						};
					}
					const trimmed = body.newBranchName.trim();
					if (
						trimmed.length === 0 ||
						/\s/.test(trimmed) ||
						trimmed.startsWith('-') ||
						trimmed.includes('..')
					) {
						ctx.set.status = 400;
						return {
							code: 'INVALID_BRANCH_NAME',
							message: 'newBranchName is empty or contains invalid characters',
						};
					}
					newBranchName = trimmed;
				}
				const force =
					typeof body.force === 'boolean' ? body.force : undefined;

				const result = await AppRuntime.runPromise(
					Effect.flatMap(ChatChangesPushService, (svc) =>
						svc.attemptMergeAndPush({
							prId: ctx.params.prId,
							userId: ctx.session.user.id,
							...(newBranchName !== undefined ? { newBranchName } : {}),
							...(force !== undefined ? { force } : {}),
						}),
					),
				);
				// Conflict / remote-changed / ref-exists are expected non-error
				// outcomes — surface 409 so the client can branch on the status
				// code in addition to the body.
				if (result.status === 'conflict') {
					ctx.set.status = 409;
					return result;
				}
				if (result.status === 'remote-changed') {
					ctx.set.status = 409;
					return result;
				}
				if (result.status === 'ref-exists') {
					ctx.set.status = 409;
					return result;
				}
				return result;
			} catch (e) {
				const err = unwrapEffectError(e);
				if (err instanceof ConcurrentPushError) {
					ctx.set.status = 409;
					return { code: 'CONCURRENT_PUSH', message: 'A push is already in progress for this PR' };
				}
				if (err instanceof ChatStreamingConflictError) {
					ctx.set.status = 409;
					return {
						code: 'CHAT_STREAMING',
						message: 'Wait for the chat agent to finish before pushing',
					};
				}
				if (err instanceof DirtyWorktreeError) {
					ctx.set.status = 422;
					return { code: 'DIRTY_WORKTREE', message: err.message };
				}
				if (err instanceof NoChangesError) {
					ctx.set.status = 422;
					return { code: 'NO_CHANGES', message: 'No agent commits to push' };
				}
				if (err instanceof NoChatSessionError) {
					ctx.set.status = 422;
					return {
						code: 'NO_CHAT_SESSION',
						message: 'No chat session for this PR — start a chat first',
					};
				}
				if (err instanceof InvalidBranchNameError) {
					ctx.set.status = 400;
					return { code: 'INVALID_BRANCH_NAME', message: err.message };
				}
				if (err instanceof RefAlreadyExistsError) {
					ctx.set.status = 409;
					return { code: 'REF_EXISTS', message: `branch ${err.ref} already exists` };
				}
				if (err instanceof PushRejectedError) {
					ctx.set.status = 502;
					return { code: 'PUSH_REJECTED', message: err.message };
				}
				return handleAppError(e, ctx);
			}
		},
		{
			params: t.Object({ prId: t.String() }),
			body: t.Optional(
				t.Object({
					newBranchName: t.Optional(t.String()),
					force: t.Optional(t.Boolean()),
				}),
			),
		},
	)
	.post(
		'/api/chat/:prId/proposed-changes/resolve-and-push',
		async (ctx) => {
			try {
				const stream = await AppRuntime.runPromise(
					Effect.flatMap(ChatChangesPushService, (svc) =>
						svc.resolveConflictsAndPush({
							prId: ctx.params.prId,
							userId: ctx.session.user.id,
						}),
					),
				);

				return new Response(resolvePushStreamToSSE(stream), {
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
			params: t.Object({ prId: t.String() }),
		},
	)
	// ── Unpushed commit management ───────────────────────────────────────────
	// Three endpoints to handle the WorktreeBlockedByUnpushedCommits scenario:
	//   DELETE …/:sha      — discard a single agent commit via rebase --onto
	//   POST …/rebase-onto — rebase all agent commits onto the new PR head
	//   POST …/advance     — advance the worktree to the new PR head (after
	//                        all commits have been handled)
	.post(
		'/api/chat/:prId/proposed-changes/cherry-pick',
		async (ctx) => {
			const body = (ctx.body ?? {}) as { sha?: unknown };
			if (typeof body.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(body.sha)) {
				ctx.set.status = 400;
				return { error: 'sha is required and must be a valid commit hash' };
			}
			const { sha } = body;

			try {
				const result = await AppRuntime.runPromise(
					Effect.flatMap(ChatChangesPushService, (svc) =>
						svc.cherryPickAndPush({
							prId: ctx.params.prId,
							userId: ctx.session.user.id,
							sha,
						}),
					),
				);

				if (result.status === 'pushed') {
					return jsonResponse({ status: 'pushed', newSha: result.newSha, pushedCommits: result.pushedCommits, branch: result.branch }, 200);
				}
				if (result.status === 'remote-changed') {
					ctx.set.status = 409;
					return { status: 'remote-changed', branch: result.branch };
				}
				ctx.set.status = 500;
				return { error: 'Unexpected cherry-pick result' };
			} catch (e) {
				const err = unwrapEffectError(e);
				if (err instanceof ConcurrentPushError) {
					ctx.set.status = 409;
					return { code: 'CONCURRENT_PUSH', message: 'Another push is already in progress for this PR' };
				}
				if (err instanceof DirtyWorktreeError) {
					ctx.set.status = 409;
					return { code: 'DIRTY_WORKTREE', message: err.message };
				}
				if (err instanceof NoChangesError) {
					ctx.set.status = 409;
					return { code: 'NO_CHANGES', message: 'No proposed commits found' };
				}
				if (err instanceof NoChatSessionError) {
					ctx.set.status = 404;
					return { code: 'NO_CHAT_SESSION', message: 'No chat session found for this PR' };
				}
				logError('chat-cherry-pick', err instanceof Error ? err.message : String(err));
				ctx.set.status = 500;
				return { error: err instanceof Error ? err.message : 'Internal error' };
			}
		},
		{
			params: t.Object({ prId: t.String() }),
		},
	)
	.delete(
		'/api/chat/:prId/proposed-changes/:sha',
		async (ctx) => {
			// Validate SHA before doing anything expensive.
			if (!/^[0-9a-f]{7,40}$/i.test(ctx.params.sha)) {
				ctx.set.status = 400;
				return { error: 'Invalid commit SHA' };
			}

			try {
				const row = await AppRuntime.runPromise(
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
						return yield* chatSessions.findLatestForPr(pr.id, agent);
					}),
				);

				if (!row) {
					ctx.set.status = 404;
					return { error: 'No chat session found for this PR' };
				}

				const { worktreePath } = row;

				// Resolve the full 40-char SHA in case a short SHA was supplied.
				const fullSha = await gitStdout(
					['rev-parse', ctx.params.sha],
					worktreePath,
					5_000,
				).catch(() => null);
				if (!fullSha?.trim()) {
					ctx.set.status = 404;
					return { error: 'Commit not found in worktree' };
				}
				const sha = fullSha.trim();

				const parentSha = await gitStdout(
					['rev-parse', `${sha}^`],
					worktreePath,
					5_000,
				).catch(() => null);
				if (!parentSha?.trim()) {
					ctx.set.status = 422;
					return { error: 'Cannot discard root commit' };
				}

				// Drop `sha` by rebasing everything above it onto its parent.
				// git rebase --onto <parent> <sha> HEAD
				try {
					await gitStdout(
						['rebase', '--onto', parentSha.trim(), sha, 'HEAD'],
						worktreePath,
						30_000,
					);
				} catch (rebaseErr) {
					await gitStdoutBestEffort(['rebase', '--abort'], worktreePath);
					ctx.set.status = 409;
					return {
						code: 'REBASE_CONFLICT',
						message:
							rebaseErr instanceof Error
								? rebaseErr.message
								: 'Rebase conflict — use the agent to resolve',
					};
				}

				return jsonResponse({ status: 'discarded' }, 200);
			} catch (e) {
				const err = unwrapEffectError(e);
				ctx.set.status = 500;
				return { error: err instanceof Error ? err.message : 'Internal error' };
			}
		},
		{
			params: t.Object({ prId: t.String(), sha: t.String() }),
		},
	)
	.post(
		'/api/chat/:prId/proposed-changes/rebase-onto',
		async (ctx) => {
			const body = (ctx.body ?? {}) as { oldHeadSha?: unknown; newHeadSha?: unknown };
			if (typeof body.oldHeadSha !== 'string' || typeof body.newHeadSha !== 'string') {
				ctx.set.status = 400;
				return { error: 'oldHeadSha and newHeadSha are required strings' };
			}
			const { oldHeadSha, newHeadSha } = body;

			try {
				const row = await AppRuntime.runPromise(
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
						return yield* chatSessions.findLatestForPr(pr.id, agent);
					}),
				);

				if (!row) {
					ctx.set.status = 404;
					return { error: 'No chat session found for this PR' };
				}

				const { worktreePath } = row;

				// Ensure newHeadSha is present in the local object store.
				await gitStdoutBestEffort(['fetch', 'origin', newHeadSha], worktreePath);

				// Rebase agent commits onto the new PR head.
				// git rebase --onto <newHeadSha> <oldHeadSha> HEAD
				try {
					await gitStdout(
						['rebase', '--onto', newHeadSha, oldHeadSha, 'HEAD'],
						worktreePath,
						60_000,
					);
				} catch (rebaseErr) {
					await gitStdoutBestEffort(['rebase', '--abort'], worktreePath);
					ctx.set.status = 409;
					return {
						code: 'REBASE_CONFLICT',
						message:
							rebaseErr instanceof Error
								? rebaseErr.message
								: 'Rebase conflict — use the agent to resolve',
					};
				}

				return jsonResponse({ status: 'rebased' }, 200);
			} catch (e) {
				const err = unwrapEffectError(e);
				ctx.set.status = 500;
				return { error: err instanceof Error ? err.message : 'Internal error' };
			}
		},
		{
			params: t.Object({ prId: t.String() }),
		},
	)
	.post(
		'/api/chat/:prId/proposed-changes/advance',
		async (ctx) => {
			const body = (ctx.body ?? {}) as { newHeadSha?: unknown };
			if (typeof body.newHeadSha !== 'string') {
				ctx.set.status = 400;
				return { error: 'newHeadSha is required' };
			}
			const { newHeadSha } = body;

			try {
				await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prCtx = yield* PrContextService;
						const chatSessions = yield* ChatSessionService;
						const settingsService = yield* SettingsService;
						const repoClone = yield* RepoCloneService;
						const { db } = yield* DbService;

						const { pr, repo, token } = yield* prCtx.resolveBasic(
							ctx.params.prId,
							ctx.session.user.id,
						);
						const settings = yield* withDb(db, settingsService.getSettings()).pipe(
							Effect.orElseSucceed(
								() => ({ aiAgent: 'opencode' }) as { aiAgent: string | null },
							),
						);
						const agent = resolveAgent(settings);

						const row = yield* chatSessions.findLatestForPr(pr.id, agent);
						if (!row) return;

						// Re-acquire with the new SHA. At this point all agent
						// commits have been handled, so this should succeed.
						yield* repoClone.acquirePrWorktree({
							repoId: repo.id,
							prNumber: pr.externalId,
							prHeadSha: newHeadSha,
							githubToken: token,
						});

						// Keep the session row's prHeadSha in sync.
						yield* chatSessions.updatePrHeadSha({
							chatSessionId: row.id,
							prHeadSha: newHeadSha,
						});
					}),
				);

				return jsonResponse({ status: 'advanced' }, 200);
			} catch (e) {
				const err = unwrapEffectError(e);
				ctx.set.status = 500;
				return { error: err instanceof Error ? err.message : 'Internal error' };
			}
		},
		{
			params: t.Object({ prId: t.String() }),
		},
	);

/**
 * Wrap a ResolvePushFrame stream into SSE bytes. Mirrors the shape of
 * `chatStreamToSSE` so the web client can reuse `parseSSEBuffer`.
 */
function resolvePushStreamToSSE(
	frameStream: ReadableStream<ResolvePushFrame>,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = frameStream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
					);
				}
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
			} catch (err) {
				const errMsg = JSON.stringify({
					code: 'GENERATION_ERROR',
					message: err instanceof Error ? err.message : 'Unknown error',
				});
				controller.enqueue(encoder.encode(`event: error\ndata: ${errMsg}\n\n`));
				controller.close();
			}
		},
	});
}
