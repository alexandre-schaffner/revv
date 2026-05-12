// ── ChatChangesPushService ─────────────────────────────────────────────────
//
// Merges the chat agent's local commits (on the per-PR working branch
// `pr-{prNumber}`) into the PR's actual remote source branch and pushes.
//
// The chat agent commits onto its own local branch in the per-PR worktree.
// That branch starts at the PR's then-current head SHA but accumulates extra
// commits the user can review via GET /api/chat/:prId/proposed-changes. This
// service is the "ship it" step the user invokes from the right-pane Push
// button: take those local commits and turn them into actual commits on the
// PR.
//
// Flow (attemptMergeAndPush):
//   1. Acquire per-PR push lock; refuse on overlap with another push.
//   2. Verify the worktree is clean and there's at least one agent commit.
//   3. Capture the remote tip via `git ls-remote` (used as the lease guard).
//   4. Fetch the remote source branch.
//   5. Switch the worktree from `pr-{N}` to a local copy of the source
//      branch (`git checkout -B {sourceBranch} origin/{sourceBranch}`).
//   6. `git merge pr-{N} --no-edit` — fast-forward when possible, real
//      merge commit otherwise.
//   7. On conflict: `git merge --abort`, restore worktree to `pr-{N}`,
//      return the conflicting file list.
//   8. On clean merge: push with `--force-with-lease={ref}:{capturedSha}`
//      using the user's GitHub token (token never lands in `.git/config`).
//   9. Move `pr-{N}` to the new tip and check it out so the worktree returns
//      to its conceptual starting state for any follow-up chat turns.
//  10. Re-fetch PR meta from GitHub so `pull_requests.headSha` reflects the
//      pushed tip via the canonical upsertPrs path.
//  11. Update `chat_sessions.prHeadSha = newTip` so session lookup keeps
//      finding this conversation rather than orphaning it.
//  12. Broadcast `prs:updated`.
//
// Conflict resolution path (resolveConflictsAndPush) re-runs the merge into
// the conflicted state and hands the worktree to the chat agent via
// AiService.resolveMergeConflict (a one-shot, non-persisted agent run with
// a dedicated system prompt). Stream frames flow through to the SSE client
// so the user sees the agent's progress inline. After the agent stream ends:
//   - if MERGE_HEAD is gone and the index is clean, finish the push as
//     above.
//   - if not, `git merge --abort` so the worktree returns to a clean
//     `pr-{N}` checkout and the user can decide what to do.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { GITHUB_HOST } from "../auth";
import {
	type AiError,
	GitHubAuthError,
	type GitHubError,
	type NotFoundError,
} from "../domain/errors";
import { logError } from "../logger";
import { AiService } from "./Ai";
import {
	runGit,
	runGitBestEffort,
	runGitCapture,
	spawnGit,
} from "./git-runner";
import { ChatSessionService } from "./ChatSession";
import { DbService } from "./Db";
import { GitHubService } from "./GitHub";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { PrContextService } from "./PrContext";
import { PullRequestService } from "./PullRequest";
import { WebSocketHub } from "./WebSocketHub";

// ── Errors ──────────────────────────────────────────────────────────────────

export class DirtyWorktreeError extends Data.TaggedError("DirtyWorktreeError")<{
	readonly message: string;
}> {}

export class ConcurrentPushError extends Data.TaggedError("ConcurrentPushError")<{
	readonly prId: string;
}> {}

export class ChatStreamingConflictError extends Data.TaggedError(
	"ChatStreamingConflictError",
)<{
	readonly prId: string;
}> {}

export class NoChangesError extends Data.TaggedError("NoChangesError")<{
	readonly prId: string;
}> {}

export class NoChatSessionError extends Data.TaggedError("NoChatSessionError")<{
	readonly prId: string;
}> {}

export class PushRejectedError extends Data.TaggedError("PushRejectedError")<{
	readonly message: string;
}> {}

export class GitOperationError extends Data.TaggedError("GitOperationError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class RefAlreadyExistsError extends Data.TaggedError(
	"RefAlreadyExistsError",
)<{
	readonly ref: string;
}> {}

export class InvalidBranchNameError extends Data.TaggedError(
	"InvalidBranchNameError",
)<{
	readonly message: string;
}> {}

export type ChatPushError =
	| DirtyWorktreeError
	| ConcurrentPushError
	| ChatStreamingConflictError
	| NoChangesError
	| NoChatSessionError
	| PushRejectedError
	| GitOperationError
	| RefAlreadyExistsError
	| InvalidBranchNameError
	| NotFoundError
	| GitHubAuthError
	| GitHubError
	| AiError;

// ── Result shape ─────────────────────────────────────────────────────────────

export type AttemptPushResult =
	| {
		readonly status: "pushed";
		readonly newSha: string;
		readonly pushedCommits: number;
		readonly branch: string;
	}
	| {
		readonly status: "conflict";
		readonly files: readonly string[];
		readonly branch: string;
	}
	| {
		readonly status: "remote-changed";
		readonly branch: string;
	}
	| {
		readonly status: "ref-exists";
		readonly branch: string;
	};

// ── Streaming feedback for resolve-and-push ──────────────────────────────────

export type ResolvePushFrame =
	| { readonly kind: "status"; readonly message: string }
	| { readonly kind: "conflict-files"; readonly files: readonly string[] }
	| { readonly kind: "agent-text"; readonly data: string }
	| {
		readonly kind: "agent-activity";
		readonly activityKind: string;
		readonly toolName: string | null;
		readonly summary: string;
		readonly payload?: unknown;
	}
	| {
		readonly kind: "result";
		readonly status: "pushed";
		readonly newSha: string;
		readonly pushedCommits: number;
		readonly branch: string;
	}
	| {
		readonly kind: "result";
		readonly status: "remote-changed";
		readonly branch: string;
	}
	| {
		readonly kind: "result";
		readonly status: "failed";
		readonly message: string;
	};

// ── Service ─────────────────────────────────────────────────────────────────

export class ChatChangesPushService extends Context.Tag(
	"ChatChangesPushService",
)<
	ChatChangesPushService,
	{
		readonly attemptMergeAndPush: (params: {
			readonly prId: string;
			readonly userId: string;
			readonly newBranchName?: string;
			readonly force?: boolean;
		}) => Effect.Effect<
			AttemptPushResult,
			ChatPushError,
			DbService | GitHubEtagCache
		>;

		readonly resolveConflictsAndPush: (params: {
			readonly prId: string;
			readonly userId: string;
		}) => Effect.Effect<
			ReadableStream<ResolvePushFrame>,
			ChatPushError,
			DbService | GitHubEtagCache
		>;

		readonly cherryPickAndPush: (params: {
			readonly prId: string;
			readonly userId: string;
			readonly sha: string;
		}) => Effect.Effect<
			AttemptPushResult,
			ChatPushError,
			DbService | GitHubEtagCache
		>;

		readonly isPushing: (prId: string) => boolean;
		readonly markChatStreaming: (prId: string, streaming: boolean) => void;
		readonly isChatStreaming: (prId: string) => boolean;
	}
>() {}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidSha(sha: string): boolean {
	return /^[0-9a-f]{7,40}$/.test(sha);
}

function assertNotFlagLike(value: string, label: string): void {
	if (value.startsWith("-")) {
		throw new Error(`refusing to use ${label} that looks like a flag: ${value}`);
	}
}

// Block the push on any uncommitted *tracked* change — modifications,
// deletions, staged work, or unmerged conflict state — but ignore untracked
// files (`??`). Untracked entries are runtime artifacts (e.g. tool-specific
// scratch dirs like `.opencode/package-lock.json`) that aren't in the
// user-reviewed proposed-changes diff, can't be lost during the merge, and
// would otherwise wedge the Push button on perfectly safe state.
async function workingTreeIsClean(worktreePath: string): Promise<{
	clean: boolean;
	output: string;
}> {
	const raw = await runGitCapture(
		["status", "--porcelain=v1"],
		worktreePath,
		15_000,
	);
	const blocking = raw
		.split("\n")
		.filter((line) => line.length > 0 && !line.startsWith("??"))
		.join("\n");
	return { clean: blocking.length === 0, output: blocking };
}

async function listConflictFiles(worktreePath: string): Promise<string[]> {
	const out = (
		await runGitCapture(
			["diff", "--name-only", "--diff-filter=U"],
			worktreePath,
			10_000,
		)
	).trim();
	if (out.length === 0) return [];
	return out.split("\n").filter((f) => f.length > 0);
}

function isMergeInProgress(worktreePath: string): boolean {
	return existsSync(join(worktreePath, ".git", "MERGE_HEAD"));
}

async function lsRemoteHead(
	clonePath: string,
	authedUrl: string,
	branch: string,
): Promise<string | null> {
	const out = await runGitCapture(
		["ls-remote", authedUrl, `refs/heads/${branch}`],
		clonePath,
		30_000,
	);
	const line = out.trim().split("\n")[0];
	if (!line) return null;
	const tab = line.indexOf("\t");
	if (tab < 0) return null;
	const sha = line.slice(0, tab).trim();
	return isValidSha(sha) ? sha : null;
}

async function pushWithLease(
	worktreePath: string,
	authedUrl: string,
	localRef: string,
	remoteBranch: string,
	expectedRemoteSha: string,
): Promise<{ ok: boolean; stderr: string }> {
	const result = await spawnGit(
		[
			"push",
			`--force-with-lease=refs/heads/${remoteBranch}:${expectedRemoteSha}`,
			authedUrl,
			`${localRef}:refs/heads/${remoteBranch}`,
		],
		{ cwd: worktreePath, timeoutMs: 120_000, captureStdout: false },
	);
	return {
		ok: !result.timedOut && result.exitCode === 0,
		stderr: result.stderrTail,
	};
}

async function pushFastForward(
	worktreePath: string,
	authedUrl: string,
	localRef: string,
	remoteBranch: string,
): Promise<{ ok: boolean; stderr: string }> {
	const result = await spawnGit(
		["push", authedUrl, `${localRef}:refs/heads/${remoteBranch}`],
		{ cwd: worktreePath, timeoutMs: 120_000, captureStdout: false },
	);
	return {
		ok: !result.timedOut && result.exitCode === 0,
		stderr: result.stderrTail,
	};
}

async function pushNewBranch(
	worktreePath: string,
	authedUrl: string,
	localRef: string,
	remoteBranch: string,
	force: boolean,
): Promise<{ ok: boolean; stderr: string }> {
	const args = ["push"];
	if (force) args.push("--force");
	args.push(authedUrl, `${localRef}:refs/heads/${remoteBranch}`);
	const result = await spawnGit(args, {
		cwd: worktreePath,
		timeoutMs: 120_000,
		captureStdout: false,
	});
	return {
		ok: !result.timedOut && result.exitCode === 0,
		stderr: result.stderrTail,
	};
}

// ── Live ────────────────────────────────────────────────────────────────────

export const ChatChangesPushServiceLive = Layer.effect(
	ChatChangesPushService,
	Effect.gen(function* () {
		const prCtx = yield* PrContextService;
		const chatSessions = yield* ChatSessionService;
		const wsHub = yield* WebSocketHub;
		const github = yield* GitHubService;
		const prService = yield* PullRequestService;
		const ai = yield* AiService;
		const { db } = yield* DbService;
		const etagCache = yield* GitHubEtagCache;

		/**
		 * Provide both layer-level services to an Effect so it can be
		 * `runPromise`-d from imperative async code (the SSE stream's
		 * start callback). We need both because PR meta refresh hits
		 * `getPrMeta`, which depends on `GitHubEtagCache` AND `DbService`.
		 */
		const runWithDeps = <A, E>(
			eff: Effect.Effect<A, E, DbService | GitHubEtagCache>,
		): Promise<A> =>
			Effect.runPromise(
				eff.pipe(
					Effect.provideService(DbService, { db }),
					Effect.provideService(GitHubEtagCache, etagCache),
				),
			);

		// Per-PR push lock — refuses overlap.
		const inFlight = new Set<string>();
		const streamingChats = new Set<string>();

		// Preflight returns context bound to a chat session and verifies the
		// worktree is in a state where push is meaningful. R surfaces
		// DbService so callers (under AppRuntime) get it for free.
		const preflight = (params: {
			readonly prId: string;
			readonly userId: string;
		}) =>
			Effect.gen(function* () {
				if (streamingChats.has(params.prId)) {
					return yield* Effect.fail(
						new ChatStreamingConflictError({ prId: params.prId }),
					);
				}

				const { pr, repo, token } = yield* prCtx.resolveBasic(
					params.prId,
					params.userId,
				);

				if (!pr.headSha) {
					return yield* Effect.fail(
						new GitOperationError({
							message:
								"PR has no head SHA recorded yet — wait for the next sync",
						}),
					);
				}

				// Find a chat session for the PR's current head SHA. Try both
				// agent flavors — pick whichever one has commits.
				const opencodeSession = yield* chatSessions.find(
					pr.id,
					"opencode",
					pr.headSha,
				);
				const claudeSession = yield* chatSessions.find(
					pr.id,
					"claude",
					pr.headSha,
				);
				const session = opencodeSession ?? claudeSession;
				if (!session) {
					return yield* Effect.fail(
						new NoChatSessionError({ prId: params.prId }),
					);
				}

				if (!isValidSha(session.prHeadSha)) {
					return yield* Effect.fail(
						new GitOperationError({
							message: `chat session has invalid prHeadSha: ${session.prHeadSha}`,
						}),
					);
				}
				assertNotFlagLike(session.branchName, "branchName");
				assertNotFlagLike(pr.sourceBranch, "sourceBranch");

				const cleanCheck = yield* Effect.tryPromise({
					try: () => workingTreeIsClean(session.worktreePath),
					catch: (err) =>
						new GitOperationError({
							message: err instanceof Error ? err.message : String(err),
							cause: err,
						}),
				});
				if (!cleanCheck.clean) {
					return yield* Effect.fail(
						new DirtyWorktreeError({
							message: `worktree has uncommitted changes:\n${cleanCheck.output}`,
						}),
					);
				}

				const aheadOut = yield* Effect.tryPromise({
					try: () =>
						runGitCapture(
							[
								"rev-list",
								"--count",
								`${session.prHeadSha}..${session.branchName}`,
							],
							session.worktreePath,
							10_000,
						),
					catch: (err) =>
						new GitOperationError({
							message: err instanceof Error ? err.message : String(err),
							cause: err,
						}),
				});
				const aheadCount = Number.parseInt(aheadOut.trim(), 10);
				if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
					return yield* Effect.fail(
						new NoChangesError({ prId: params.prId }),
					);
				}

				return { pr, repo, token, session, aheadCount };
			});

		const fetchSourceBranch = (params: {
			worktreePath: string;
			authedUrl: string;
			sourceBranch: string;
		}) =>
			Effect.tryPromise({
				try: async () => {
					await runGit(
						[
							"fetch",
							params.authedUrl,
							`+refs/heads/${params.sourceBranch}:refs/remotes/origin/${params.sourceBranch}`,
						],
						params.worktreePath,
					);
				},
				catch: (err) =>
					new GitOperationError({
						message: `failed to fetch ${params.sourceBranch}: ${
							err instanceof Error ? err.message : String(err)
						}`,
						cause: err,
					}),
			});

		const beginPush = (prId: string): Effect.Effect<void, ConcurrentPushError> =>
			Effect.suspend(() => {
				if (inFlight.has(prId)) {
					return Effect.fail(new ConcurrentPushError({ prId }));
				}
				inFlight.add(prId);
				return Effect.void;
			});

		const releasePush = (prId: string) =>
			Effect.sync(() => {
				inFlight.delete(prId);
			});

		const restoreToAgentBranch = (params: {
			worktreePath: string;
			branchName: string;
		}) =>
			Effect.promise(async () => {
				const ok = await runGitBestEffort(
					["checkout", params.branchName],
					params.worktreePath,
					15_000,
				);
				if (!ok) {
					logError(
						"chat-push",
						`failed to restore worktree to ${params.branchName}`,
					);
				}
			});

		const restoreAgentBranchToTip = (params: {
			worktreePath: string;
			branchName: string;
			newTip: string;
		}) =>
			Effect.tryPromise({
				try: async () => {
					await runGit(
						["branch", "-f", params.branchName, params.newTip],
						params.worktreePath,
					);
					await runGit(
						["checkout", params.branchName],
						params.worktreePath,
					);
				},
				catch: (err) =>
					new GitOperationError({
						message: err instanceof Error ? err.message : String(err),
						cause: err,
					}),
			});

		// After cherry-picking a single commit, rebase the remaining agent commits
		// onto the new source-branch tip, dropping the commit that was just pushed.
		// If the rebase conflicts, we abort and restore the agent branch to its
		// pre-cherry-pick state — the push still succeeded so we don't fail the
		// overall operation, but we log so the user can retry.
		const rebaseAgentBranchAfterCherryPick = (params: {
			worktreePath: string;
			branchName: string;
			newTip: string;
			cherryPickedSha: string;
			oldAgentTip: string;
		}) =>
			Effect.promise(async () => {
				// git rebase --onto <newTip> <cherryPickedSha> <oldAgentTip>
				// replays the range (cherryPickedSha..oldAgentTip] onto newTip,
				// which drops the cherry-picked commit and keeps everything else.
				const result = await spawnGit(
					["rebase", "--onto", params.newTip, params.cherryPickedSha, params.oldAgentTip],
					{ cwd: params.worktreePath, timeoutMs: 60_000, captureStdout: false },
				);

				if (result.timedOut || result.exitCode !== 0) {
					await runGitBestEffort(["rebase", "--abort"], params.worktreePath, 15_000);
					await runGitBestEffort(["branch", "-f", params.branchName, params.oldAgentTip], params.worktreePath, 5_000);
					await runGitBestEffort(["checkout", params.branchName], params.worktreePath, 10_000);
					logError("cherry-pick", "rebase of remaining agent commits failed; restored agent branch to pre-cherry-pick tip");
					return;
				}

				const rebasedTipOut = await runGitCapture(["rev-parse", "HEAD"], params.worktreePath, 5_000).catch(() => null);
				const rebasedTip = rebasedTipOut?.trim();
				if (!rebasedTip || !isValidSha(rebasedTip)) {
					await runGitBestEffort(["branch", "-f", params.branchName, params.oldAgentTip], params.worktreePath, 5_000);
					await runGitBestEffort(["checkout", params.branchName], params.worktreePath, 10_000);
					logError("cherry-pick", "could not resolve HEAD after rebase; restored agent branch to pre-cherry-pick tip");
					return;
				}

				await runGit(["branch", "-f", params.branchName, rebasedTip], params.worktreePath);
				await runGit(["checkout", params.branchName], params.worktreePath);
			});

		const finalizeStateAfterPush = (params: {
			pr: { readonly id: string };
			repo: { readonly fullName: string };
			prExternalId: number;
			token: string;
			sessionId: string;
			newTip: string;
		}) =>
			Effect.gen(function* () {
				const fresh = yield* prService.listPrs().pipe(
					Effect.map((prs) => prs.find((p) => p.id === params.pr.id) ?? null),
				);
				if (fresh) {
					const metaOpt = yield* github
						.getPrMeta(
							params.repo.fullName,
							params.prExternalId,
							params.token,
						)
						.pipe(Effect.option);
					const headSha =
						metaOpt._tag === "Some" ? metaOpt.value.headSha : params.newTip;
					yield* prService
						.upsertPrs([
							{
								...fresh,
								headSha,
								fetchedAt: new Date().toISOString(),
							},
						])
						.pipe(Effect.catchAll(() => Effect.void));
				}

				yield* chatSessions.updatePrHeadSha({
					chatSessionId: params.sessionId,
					prHeadSha: params.newTip,
				});

				yield* wsHub.broadcast({
					type: "prs:updated",
					data: {},
				} as never);
			});

		const completePush = (params: {
			pr: {
				readonly id: string;
				readonly externalId: number;
				readonly sourceBranch: string;
			};
			repo: { readonly fullName: string };
			token: string;
			session: {
				readonly id: string;
				readonly worktreePath: string;
				readonly branchName: string;
			};
			authedUrl: string;
			expectedRemoteSha: string | null;
			aheadCount: number;
			// When set, rebase remaining agent commits onto the new tip instead of
			// force-resetting the branch. Used by cherryPickAndPush so only the
			// cherry-picked commit is dropped, preserving the rest.
			cherryPickRebase?: { readonly cherryPickedSha: string; readonly oldAgentTip: string };
		}) =>
			Effect.gen(function* () {
				const pushResult = yield* Effect.tryPromise({
					try: () =>
						params.expectedRemoteSha
							? pushWithLease(
								params.session.worktreePath,
								params.authedUrl,
								"HEAD",
								params.pr.sourceBranch,
								params.expectedRemoteSha,
							)
							: pushFastForward(
								params.session.worktreePath,
								params.authedUrl,
								"HEAD",
								params.pr.sourceBranch,
							),
					catch: (err) =>
						new GitOperationError({
							message: err instanceof Error ? err.message : String(err),
							cause: err,
						}),
				});

				if (!pushResult.ok) {
					const stderr = pushResult.stderr.toLowerCase();
					yield* restoreToAgentBranch({
						worktreePath: params.session.worktreePath,
						branchName: params.session.branchName,
					});
					if (
						stderr.includes("stale info") ||
						stderr.includes("non-fast-forward") ||
						stderr.includes("rejected") ||
						stderr.includes("fetch first")
					) {
						return {
							status: "remote-changed" as const,
							branch: params.pr.sourceBranch,
						};
					}
					if (
						stderr.includes("authentication") ||
						stderr.includes("403") ||
						stderr.includes("401")
					) {
						return yield* Effect.fail(
							new GitHubAuthError({
								message:
									"git push rejected: token expired or insufficient scope",
							}),
						);
					}
					return yield* Effect.fail(
						new PushRejectedError({
							message: pushResult.stderr || "git push failed",
						}),
					);
				}

				const newTipOut = yield* Effect.tryPromise({
					try: () =>
						runGitCapture(
							["rev-parse", "HEAD"],
							params.session.worktreePath,
							10_000,
						),
					catch: (err) =>
						new GitOperationError({
							message: err instanceof Error ? err.message : String(err),
							cause: err,
						}),
				});
				const newTip = newTipOut.trim();
				if (!isValidSha(newTip)) {
					return yield* Effect.fail(
						new GitOperationError({
							message: `invalid new tip from rev-parse: ${newTip}`,
						}),
					);
				}

				if (params.cherryPickRebase) {
					yield* rebaseAgentBranchAfterCherryPick({
						worktreePath: params.session.worktreePath,
						branchName: params.session.branchName,
						newTip,
						cherryPickedSha: params.cherryPickRebase.cherryPickedSha,
						oldAgentTip: params.cherryPickRebase.oldAgentTip,
					});
				} else {
					yield* restoreAgentBranchToTip({
						worktreePath: params.session.worktreePath,
						branchName: params.session.branchName,
						newTip,
					});
				}

				yield* finalizeStateAfterPush({
					pr: { id: params.pr.id },
					repo: params.repo,
					prExternalId: params.pr.externalId,
					token: params.token,
					sessionId: params.session.id,
					newTip,
				});

				return {
					status: "pushed" as const,
					newSha: newTip,
					pushedCommits: params.aheadCount,
					branch: params.pr.sourceBranch,
				};
			});

		const performMerge = (params: {
			worktreePath: string;
			branchName: string;
			sourceBranch: string;
			abortOnConflict: boolean;
		}): Effect.Effect<
			| { readonly status: "merged" }
			| { readonly status: "conflict"; readonly files: readonly string[] },
			GitOperationError
		> =>
			Effect.tryPromise({
				try: async () => {
					await runGit(
						[
							"checkout",
							"-B",
							params.sourceBranch,
							`refs/remotes/origin/${params.sourceBranch}`,
						],
						params.worktreePath,
					);

					const mergeResult = await spawnGit(
						["merge", "--no-edit", params.branchName],
						{
							cwd: params.worktreePath,
							timeoutMs: 60_000,
							captureStdout: false,
						},
					);

					if (!mergeResult.timedOut && mergeResult.exitCode === 0) {
						return { status: "merged" } as const;
					}

					if (!isMergeInProgress(params.worktreePath)) {
						throw new Error(
							`git merge failed: ${mergeResult.stderrTail || "unknown error"}`,
						);
					}

					const files = await listConflictFiles(params.worktreePath);
					if (params.abortOnConflict) {
						await runGitBestEffort(
							["merge", "--abort"],
							params.worktreePath,
							15_000,
						);
					}
					return { status: "conflict", files } as const;
				},
				catch: (err) =>
					new GitOperationError({
						message: err instanceof Error ? err.message : String(err),
						cause: err,
					}),
			});

		// "Push to new branch" path: skip the merge/lease dance entirely. Just
		// push the agent branch as-is to a brand-new ref. PR meta and chat
		// session state are intentionally untouched — the PR's source branch
		// hasn't moved.
		const pushToNewBranchEffect = (params: {
			ctx: {
				readonly pr: { readonly sourceBranch: string };
				readonly session: {
					readonly worktreePath: string;
					readonly branchName: string;
				};
				readonly aheadCount: number;
			};
			authedUrl: string;
			newBranchName: string;
			force: boolean;
		}): Effect.Effect<AttemptPushResult, ChatPushError> =>
			Effect.gen(function* () {
				const trimmed = params.newBranchName.trim();
				if (trimmed.length === 0 || /\s/.test(trimmed) || trimmed.includes("..")) {
					return yield* Effect.fail(
						new InvalidBranchNameError({
							message: `invalid branch name: ${params.newBranchName}`,
						}),
					);
				}
				try {
					assertNotFlagLike(trimmed, "newBranchName");
				} catch (err) {
					return yield* Effect.fail(
						new InvalidBranchNameError({
							message: err instanceof Error ? err.message : String(err),
						}),
					);
				}

				if (!params.force) {
					const existing = yield* Effect.tryPromise({
						try: () =>
							lsRemoteHead(
								params.ctx.session.worktreePath,
								params.authedUrl,
								trimmed,
							),
						catch: (err) =>
							new GitOperationError({
								message: err instanceof Error ? err.message : String(err),
								cause: err,
							}),
					});
					if (existing) {
						return {
							status: "ref-exists" as const,
							branch: trimmed,
						};
					}
				}

				const pushResult = yield* Effect.tryPromise({
					try: () =>
						pushNewBranch(
							params.ctx.session.worktreePath,
							params.authedUrl,
							params.ctx.session.branchName,
							trimmed,
							params.force,
						),
					catch: (err) =>
						new GitOperationError({
							message: err instanceof Error ? err.message : String(err),
							cause: err,
						}),
				});

				if (!pushResult.ok) {
					const stderr = pushResult.stderr.toLowerCase();
					if (
						stderr.includes("authentication") ||
						stderr.includes("403") ||
						stderr.includes("401")
					) {
						return yield* Effect.fail(
							new GitHubAuthError({
								message:
									"git push rejected: token expired or insufficient scope",
							}),
						);
					}
					if (
						!params.force &&
						(stderr.includes("already exists") ||
							stderr.includes("non-fast-forward") ||
							stderr.includes("rejected") ||
							stderr.includes("fetch first"))
					) {
						return {
							status: "ref-exists" as const,
							branch: trimmed,
						};
					}
					return yield* Effect.fail(
						new PushRejectedError({
							message: pushResult.stderr || "git push failed",
						}),
					);
				}

				const newTipOut = yield* Effect.tryPromise({
					try: () =>
						runGitCapture(
							["rev-parse", params.ctx.session.branchName],
							params.ctx.session.worktreePath,
							10_000,
						),
					catch: (err) =>
						new GitOperationError({
							message: err instanceof Error ? err.message : String(err),
							cause: err,
						}),
				});
				const newTip = newTipOut.trim();
				if (!isValidSha(newTip)) {
					return yield* Effect.fail(
						new GitOperationError({
							message: `invalid new tip from rev-parse: ${newTip}`,
						}),
					);
				}

				yield* wsHub.broadcast({
					type: "prs:updated",
					data: {},
				} as never);

				return {
					status: "pushed" as const,
					newSha: newTip,
					pushedCommits: params.ctx.aheadCount,
					branch: trimmed,
				};
			});

		const attemptMergeAndPush = (params: {
			readonly prId: string;
			readonly userId: string;
			readonly newBranchName?: string;
			readonly force?: boolean;
		}): Effect.Effect<
			AttemptPushResult,
			ChatPushError,
			DbService | GitHubEtagCache
		> =>
			Effect.gen(function* () {
				yield* beginPush(params.prId);
				return yield* Effect.gen(function* () {
					const ctx = yield* preflight(params);
					const authedUrl = `https://x-access-token:${ctx.token}@${GITHUB_HOST}/${ctx.repo.fullName}.git`;

					if (params.newBranchName !== undefined) {
						return yield* pushToNewBranchEffect({
							ctx: {
								pr: { sourceBranch: ctx.pr.sourceBranch },
								session: {
									worktreePath: ctx.session.worktreePath,
									branchName: ctx.session.branchName,
								},
								aheadCount: ctx.aheadCount,
							},
							authedUrl,
							newBranchName: params.newBranchName,
							force: params.force ?? false,
						});
					}

					const expectedRemoteSha = yield* Effect.tryPromise({
						try: () =>
							lsRemoteHead(
								ctx.session.worktreePath,
								authedUrl,
								ctx.pr.sourceBranch,
							),
						catch: (err) =>
							new GitOperationError({
								message: err instanceof Error ? err.message : String(err),
								cause: err,
							}),
					});

					yield* fetchSourceBranch({
						worktreePath: ctx.session.worktreePath,
						authedUrl,
						sourceBranch: ctx.pr.sourceBranch,
					});

					const merge = yield* performMerge({
						worktreePath: ctx.session.worktreePath,
						branchName: ctx.session.branchName,
						sourceBranch: ctx.pr.sourceBranch,
						abortOnConflict: true,
					});

					if (merge.status === "conflict") {
						yield* restoreToAgentBranch({
							worktreePath: ctx.session.worktreePath,
							branchName: ctx.session.branchName,
						});
						return {
							status: "conflict" as const,
							files: merge.files,
							branch: ctx.pr.sourceBranch,
						};
					}

					return yield* completePush({
						pr: {
							id: ctx.pr.id,
							externalId: ctx.pr.externalId,
							sourceBranch: ctx.pr.sourceBranch,
						},
						repo: { fullName: ctx.repo.fullName },
						token: ctx.token,
						session: {
							id: ctx.session.id,
							worktreePath: ctx.session.worktreePath,
							branchName: ctx.session.branchName,
						},
						authedUrl,
						expectedRemoteSha,
						aheadCount: ctx.aheadCount,
					});
				}).pipe(Effect.ensuring(releasePush(params.prId)));
			});

		const resolveConflictsAndPush = (params: {
			readonly prId: string;
			readonly userId: string;
		}): Effect.Effect<
			ReadableStream<ResolvePushFrame>,
			ChatPushError,
			DbService | GitHubEtagCache
		> =>
			Effect.gen(function* () {
				yield* beginPush(params.prId);

				// Resolve preflight + fetch up front so a hard error fails
				// the request synchronously rather than in the SSE stream.
				const ctx = yield* preflight(params).pipe(
					Effect.tapError(() => releasePush(params.prId)),
				);

				const authedUrl = `https://x-access-token:${ctx.token}@${GITHUB_HOST}/${ctx.repo.fullName}.git`;

				yield* fetchSourceBranch({
					worktreePath: ctx.session.worktreePath,
					authedUrl,
					sourceBranch: ctx.pr.sourceBranch,
				}).pipe(Effect.tapError(() => releasePush(params.prId)));

				const expectedRemoteSha = yield* Effect.tryPromise({
					try: () =>
						lsRemoteHead(
							ctx.session.worktreePath,
							authedUrl,
							ctx.pr.sourceBranch,
						),
					catch: (err) =>
						new GitOperationError({
							message: err instanceof Error ? err.message : String(err),
							cause: err,
						}),
				}).pipe(Effect.tapError(() => releasePush(params.prId)));

				// Re-run the merge into the conflict state (keep MERGE_HEAD
				// for the agent to resolve).
				const merge = yield* performMerge({
					worktreePath: ctx.session.worktreePath,
					branchName: ctx.session.branchName,
					sourceBranch: ctx.pr.sourceBranch,
					abortOnConflict: false,
				}).pipe(Effect.tapError(() => releasePush(params.prId)));

				if (merge.status === "merged") {
					// Surprise — merge applied cleanly without conflicts. Push.
					const pushed: AttemptPushResult = yield* completePush({
						pr: {
							id: ctx.pr.id,
							externalId: ctx.pr.externalId,
							sourceBranch: ctx.pr.sourceBranch,
						},
						repo: { fullName: ctx.repo.fullName },
						token: ctx.token,
						session: {
							id: ctx.session.id,
							worktreePath: ctx.session.worktreePath,
							branchName: ctx.session.branchName,
						},
						authedUrl,
						expectedRemoteSha,
						aheadCount: ctx.aheadCount,
					}).pipe(Effect.ensuring(releasePush(params.prId)));

					return new ReadableStream<ResolvePushFrame>({
						start(controller) {
							if (pushed.status === "pushed") {
								controller.enqueue({
									kind: "result",
									status: "pushed",
									newSha: pushed.newSha,
									pushedCommits: pushed.pushedCommits,
									branch: pushed.branch,
								});
							} else if (pushed.status === "remote-changed") {
								controller.enqueue({
									kind: "result",
									status: "remote-changed",
									branch: pushed.branch,
								});
							} else {
								controller.enqueue({
									kind: "result",
									status: "failed",
									message: "Unexpected push outcome.",
								});
							}
							controller.close();
						},
					});
				}

				const conflictFiles = merge.files;

				const agentStream = yield* ai.resolveMergeConflict({
					cwd: ctx.session.worktreePath,
					agentBranch: ctx.session.branchName,
					sourceBranch: ctx.pr.sourceBranch,
					conflictFiles,
					prId: ctx.pr.id,
				}).pipe(
					Effect.tapError(() =>
						Effect.gen(function* () {
							yield* Effect.promise(() =>
								runGitBestEffort(
									["merge", "--abort"],
									ctx.session.worktreePath,
									15_000,
								).then(() => undefined),
							);
							yield* restoreToAgentBranch({
								worktreePath: ctx.session.worktreePath,
								branchName: ctx.session.branchName,
							});
							yield* releasePush(params.prId);
						}),
					),
				);

				// Build the SSE stream. The push step at the end runs an
				// inner Effect.runPromise; we provide the layer services
				// captured at construction time. We need to handle errors
				// imperatively here because we're crossing the Effect/Promise
				// boundary.
				const ctxRef = ctx;
				const stream = new ReadableStream<ResolvePushFrame>({
					start: async (controller) => {
						const finalize = () => {
							inFlight.delete(params.prId);
						};

						const failAndClose = async (msg: string) => {
							try {
								await runGitBestEffort(
									["merge", "--abort"],
									ctxRef.session.worktreePath,
									15_000,
								);
							} catch {
								/* swallow — we're already in failure handling */
							}
							try {
								await Effect.runPromise(
									restoreToAgentBranch({
										worktreePath: ctxRef.session.worktreePath,
										branchName: ctxRef.session.branchName,
									}),
								);
							} catch {
								/* same */
							}
							controller.enqueue({
								kind: "result",
								status: "failed",
								message: msg,
							});
							controller.close();
							finalize();
						};

						try {
							controller.enqueue({
								kind: "status",
								message: `Re-running merge into ${ctxRef.pr.sourceBranch}...`,
							});
							controller.enqueue({
								kind: "conflict-files",
								files: conflictFiles,
							});
							controller.enqueue({
								kind: "status",
								message:
									"Asking the agent to resolve conflicts and run git merge --continue.",
							});

							const reader = agentStream.getReader();
							while (true) {
								const { done, value } = await reader.read();
								if (done) break;
								if (value.kind === "text") {
									controller.enqueue({
										kind: "agent-text",
										data: value.data,
									});
								} else if (value.kind === "activity") {
									const frame: ResolvePushFrame = {
										kind: "agent-activity",
										activityKind: value.activityKind,
										toolName: value.toolName,
										summary: value.summary,
										...(value.payload !== undefined
											? { payload: value.payload }
											: {}),
									};
									controller.enqueue(frame);
								}
							}

							if (isMergeInProgress(ctxRef.session.worktreePath)) {
								await failAndClose(
									"Agent finished but the merge is still in conflict. Aborting.",
								);
								return;
							}
							const cleanCheck = await workingTreeIsClean(
								ctxRef.session.worktreePath,
							);
							if (!cleanCheck.clean) {
								await failAndClose(
									`Worktree has uncommitted changes after agent run:\n${cleanCheck.output}`,
								);
								return;
							}

							controller.enqueue({
								kind: "status",
								message: "Merge resolved. Pushing...",
							});

							// Inner push. Errors throw out of runPromise; we
							// handle them as failed-result frames.
							const pushed = await runWithDeps(
								completePush({
									pr: {
										id: ctxRef.pr.id,
										externalId: ctxRef.pr.externalId,
										sourceBranch: ctxRef.pr.sourceBranch,
									},
									repo: { fullName: ctxRef.repo.fullName },
									token: ctxRef.token,
									session: {
										id: ctxRef.session.id,
										worktreePath: ctxRef.session.worktreePath,
										branchName: ctxRef.session.branchName,
									},
									authedUrl,
									expectedRemoteSha,
									aheadCount: ctxRef.aheadCount,
								}),
							).catch((err: unknown) => {
								logError(
									"chat-push",
									"completePush failed:",
									err instanceof Error ? err.message : String(err),
								);
								return null;
							});

							if (pushed === null) {
								controller.enqueue({
									kind: "result",
									status: "failed",
									message: "Push failed. See server logs.",
								});
							} else if (pushed.status === "pushed") {
								controller.enqueue({
									kind: "result",
									status: "pushed",
									newSha: pushed.newSha,
									pushedCommits: pushed.pushedCommits,
									branch: pushed.branch,
								});
							} else if (pushed.status === "remote-changed") {
								controller.enqueue({
									kind: "result",
									status: "remote-changed",
									branch: pushed.branch,
								});
							} else {
								controller.enqueue({
									kind: "result",
									status: "failed",
									message: "Unexpected push outcome.",
								});
							}
							controller.close();
							finalize();
						} catch (err) {
							await failAndClose(
								err instanceof Error ? err.message : String(err),
							);
						}
					},
				});

				return stream;
			});

		const cherryPickAndPush = (params: {
			readonly prId: string;
			readonly userId: string;
			readonly sha: string;
		}): Effect.Effect<AttemptPushResult, ChatPushError, DbService | GitHubEtagCache> =>
			Effect.gen(function* () {
				yield* beginPush(params.prId);
				return yield* Effect.gen(function* () {
					const ctx = yield* preflight(params);
					const authedUrl = `https://x-access-token:${ctx.token}@${GITHUB_HOST}/${ctx.repo.fullName}.git`;

					// Validate SHA exists in worktree
					const fullShaOut = yield* Effect.tryPromise({
						try: () => runGitCapture(['rev-parse', params.sha], ctx.session.worktreePath, 5_000),
						catch: (err) => new GitOperationError({ message: err instanceof Error ? err.message : String(err), cause: err }),
					});
					const fullSha = fullShaOut.trim();
					if (!isValidSha(fullSha)) {
						return yield* Effect.fail(new GitOperationError({ message: `Cannot resolve SHA: ${params.sha}` }));
					}

					const expectedRemoteSha = yield* Effect.tryPromise({
						try: () => lsRemoteHead(ctx.session.worktreePath, authedUrl, ctx.pr.sourceBranch),
						catch: (err) => new GitOperationError({ message: err instanceof Error ? err.message : String(err), cause: err }),
					});

				yield* fetchSourceBranch({ worktreePath: ctx.session.worktreePath, authedUrl, sourceBranch: ctx.pr.sourceBranch });

				// Capture the current agent branch tip before we leave it, so we can
				// rebase the remaining commits onto the new source-branch tip later.
				const savedAgentTipOut = yield* Effect.tryPromise({
					try: () => runGitCapture(['rev-parse', ctx.session.branchName], ctx.session.worktreePath, 5_000),
					catch: (err) => new GitOperationError({ message: err instanceof Error ? err.message : String(err), cause: err }),
				});
				const savedAgentTip = savedAgentTipOut.trim();

				// Checkout source branch locally
				yield* Effect.tryPromise({
					try: () => runGit(['checkout', '-B', ctx.pr.sourceBranch, `refs/remotes/origin/${ctx.pr.sourceBranch}`], ctx.session.worktreePath),
					catch: (err) => new GitOperationError({ message: err instanceof Error ? err.message : String(err), cause: err }),
				});

				// Cherry-pick the single commit
				const cpResult = yield* Effect.tryPromise({
					try: () => spawnGit(['cherry-pick', fullSha], { cwd: ctx.session.worktreePath, timeoutMs: 60_000, captureStdout: false }),
					catch: (err) => new GitOperationError({ message: err instanceof Error ? err.message : String(err), cause: err }),
				});

				if (cpResult.timedOut || cpResult.exitCode !== 0) {
					// Abort cherry-pick and restore worktree
					yield* Effect.tryPromise({
						try: () => runGitBestEffort(['cherry-pick', '--abort'], ctx.session.worktreePath, 15_000),
						catch: () => new GitOperationError({ message: 'cherry-pick --abort failed' }),
					});
					yield* restoreToAgentBranch({ worktreePath: ctx.session.worktreePath, branchName: ctx.session.branchName });
					return yield* Effect.fail(new GitOperationError({ message: `Cherry-pick failed: ${cpResult.stderrTail}` }));
				}

				return yield* completePush({
					pr: { id: ctx.pr.id, externalId: ctx.pr.externalId, sourceBranch: ctx.pr.sourceBranch },
					repo: { fullName: ctx.repo.fullName },
					token: ctx.token,
					session: { id: ctx.session.id, worktreePath: ctx.session.worktreePath, branchName: ctx.session.branchName },
					authedUrl,
					expectedRemoteSha,
					aheadCount: 1,
					cherryPickRebase: { cherryPickedSha: fullSha, oldAgentTip: savedAgentTip },
				});
				}).pipe(Effect.ensuring(releasePush(params.prId)));
			});

		return {
			attemptMergeAndPush,
			resolveConflictsAndPush,
			cherryPickAndPush,
			isPushing: (prId: string) => inFlight.has(prId),
			markChatStreaming: (prId: string, streaming: boolean) => {
				if (streaming) streamingChats.add(prId);
				else streamingChats.delete(prId);
			},
			isChatStreaming: (prId: string) => streamingChats.has(prId),
		};
	}),
);
