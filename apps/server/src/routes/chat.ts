// ── Chat route ─────────────────────────────────────────────────────────────
//
// The right-pane AI chat HTTP surface.
//
//   POST   /api/chat                                - stream a turn (SSE)
//   GET    /api/chat/:prId/proposed-changes         - list commits the agent made
//   GET    /api/chat/:prId/proposed-changes/:sha/diff - unified diff for one
//   DELETE /api/chat/:prId                          - clear the conversation
//
// Sessions are persisted in `chat_sessions` keyed on (prId, agent, prHeadSha).
// The agent's actual conversation lives in its own session store (Claude SDK
// JSONL or opencode daemon); we just remember the session id so follow-ups
// resume the same context.

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
				const frameStream = await AppRuntime.runPromise(
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

						// GC any stale row at a previous head SHA — its worktree
						// + branch are no longer relevant.
						const stale = yield* chatSessions.findStaleSibling(
							pr.id,
							agent,
							headSha,
						);
						if (stale && repo.clonePath) {
							yield* chatSessions.clear(pr.id, agent, stale.prHeadSha);
							yield* repoClone.releaseChatWorktree({
								clonePath: repo.clonePath,
								worktreePath: stale.worktreePath,
								branchName: stale.branchName,
							});
						}

						// Acquire (or reuse) the chat worktree on its working branch.
						const { worktreePath, branchName } = yield* repoClone.acquireChatWorktree({
							repoId: repo.id,
							prId: pr.id,
							prHeadSha: headSha,
							githubToken: token,
							prNumber: pr.externalId,
						});

						const existing = yield* chatSessions.find(pr.id, agent, headSha);

						// On new session, fetch walkthrough context for the system prompt.
						// On resume, the agent already has it baked into its persisted session.
						const walkthrough = existing
							? null
							: fetchWalkthroughContext(db, pr.id);

						const onSessionId = (sid: string) => {
							void AppRuntime.runPromise(
								chatSessions.upsert({
									prId: pr.id,
									agent,
									prHeadSha: headSha,
									sessionId: sid,
									worktreePath,
									branchName,
								}),
							).catch((err) => {
								logError(
									'chat',
									'chatSessions.upsert failed:',
									err instanceof Error ? err.message : String(err),
								);
							});
						};

						return yield* ai.chat({
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
							resumeSessionId: existing?.sessionId ?? null,
							onSessionId,
							prId: pr.id,
						});
					}),
				);

				return new Response(chatStreamToSSE<ChatStreamFrame>(frameStream), {
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
	.delete(
		'/api/chat/:prId',
		async (ctx) => {
			try {
				await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prCtx = yield* PrContextService;
						const chatSessions = yield* ChatSessionService;
						const repoClone = yield* RepoCloneService;
						const settingsService = yield* SettingsService;
						const { db } = yield* DbService;

						const { pr, repo } = yield* prCtx.resolveBasic(
							ctx.params.prId,
							ctx.session.user.id,
						);

						const settings = yield* withDb(db, settingsService.getSettings()).pipe(
							Effect.orElseSucceed(
								() => ({ aiAgent: 'opencode' }) as { aiAgent: string | null },
							),
						);
						const agent = resolveAgent(settings);

						// Drop every chat-session row for (pr, agent) and release
						// each worktree+branch. The user explicitly asked for a
						// fresh start so we tear down both the active row and any
						// stale-SHA row that hadn't been GC'd yet.
						const cleared = yield* chatSessions.clearAllForPr(pr.id, agent);
						if (repo.clonePath) {
							const cp = repo.clonePath;
							for (const handle of cleared) {
								yield* repoClone.releaseChatWorktree({
									clonePath: cp,
									worktreePath: handle.worktreePath,
									branchName: handle.branchName,
								});
							}
						}
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
