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

import { Context, Data, Effect, Layer, Queue } from "effect";
import { serverEnv } from "../config";
import {
  type AiError,
  GitHubAuthError,
  type GitHubError,
  type NotFoundError,
} from "../domain/errors";
import { logError } from "../logger";
import { AiService } from "./Ai";
import { Broadcaster } from "./Broadcaster";
import { ChatSessionService } from "./ChatSession";
import type { DbService } from "./Db";
import type { GitHubEtagCache } from "./GitHubEtagCache";
import {
  abortCherryPick,
  abortMerge,
  abortRebase,
  assertNotFlagLike,
  checkoutBranch,
  checkoutBranchBestEffort,
  checkoutNewBranchFromRef,
  cherryPick,
  fetchRefspec,
  forceBranchTo,
  forceBranchToBestEffort,
  GitOperationError,
  InvalidBranchNameError,
  isMergeInProgress,
  isValidSha,
  lsRemoteHead,
  merge as mergeBranch,
  PushRejectedError,
  pushFastForward,
  pushNewBranch,
  pushWithLease,
  type RefAlreadyExistsError,
  rebaseOnto,
  revListCount,
  revListReverse,
  revParse,
  unmergedPaths,
  workingTreeIsClean,
} from "./GitOps";
import { PrContextService } from "./PrContext";
import { PullRequestService } from "./PullRequest";
import { SettingsService } from "./Settings";

// Re-export the GitOps errors so existing callers that destructured them
// from this module keep working without import churn.
export {
  GitOperationError,
  InvalidBranchNameError,
  PushRejectedError,
  RefAlreadyExistsError,
} from "./GitOps";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads the configured GitHub host from Settings at call time, falling back
 * to the process-startup value. This avoids freezing the host at module load.
 */
const resolveGitHost: Effect.Effect<string, never, SettingsService> = Effect.gen(function* () {
  const settings = yield* Effect.flatMap(SettingsService, (s) => s.getSettings()).pipe(
    Effect.orElseSucceed(() => null),
  );
  return settings?.githubHost?.trim() || serverEnv.githubHost;
});

// ── Errors ──────────────────────────────────────────────────────────────────

export class DirtyWorktreeError extends Data.TaggedError("DirtyWorktreeError")<{
  readonly message: string;
}> {}

export class ConcurrentPushError extends Data.TaggedError("ConcurrentPushError")<{
  readonly prId: string;
}> {}

export class ChatStreamingConflictError extends Data.TaggedError("ChatStreamingConflictError")<{
  readonly prId: string;
}> {}

export class NoChangesError extends Data.TaggedError("NoChangesError")<{
  readonly prId: string;
}> {}

export class NoChatSessionError extends Data.TaggedError("NoChatSessionError")<{
  readonly prId: string;
}> {}

// GitOperationError, PushRejectedError, RefAlreadyExistsError, and
// InvalidBranchNameError are defined in `./GitOps` and re-exported above.

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

export class ChatChangesPushService extends Context.Tag("ChatChangesPushService")<
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
      DbService | GitHubEtagCache | SettingsService
    >;

    readonly resolveConflictsAndPush: (params: {
      readonly prId: string;
      readonly userId: string;
    }) => Effect.Effect<
      ReadableStream<ResolvePushFrame>,
      ChatPushError,
      DbService | GitHubEtagCache | SettingsService
    >;

    readonly cherryPickAndPush: (params: {
      readonly prId: string;
      readonly userId: string;
      readonly sha: string;
    }) => Effect.Effect<
      AttemptPushResult,
      ChatPushError,
      DbService | GitHubEtagCache | SettingsService
    >;

    readonly batchCherryPickAndPush: (params: {
      readonly prId: string;
      readonly userId: string;
      readonly shas: readonly string[];
    }) => Effect.Effect<
      AttemptPushResult,
      ChatPushError,
      DbService | GitHubEtagCache | SettingsService
    >;

    readonly isPushing: (prId: string) => boolean;
    readonly markChatStreaming: (prId: string, streaming: boolean) => void;
    readonly isChatStreaming: (prId: string) => boolean;
  }
>() {}

// ── Helpers ─────────────────────────────────────────────────────────────────
//
// Raw git command shapes live in `./GitOps`; this module owns chat-session
// orchestration and maps git failures into the chat-push result model.

// ── Live ────────────────────────────────────────────────────────────────────

export const ChatChangesPushServiceLive = Layer.effect(
  ChatChangesPushService,
  Effect.gen(function* () {
    const prCtx = yield* PrContextService;
    const chatSessions = yield* ChatSessionService;
    const broadcaster = yield* Broadcaster;
    const prService = yield* PullRequestService;
    const ai = yield* AiService;

    // Per-PR push lock — refuses overlap.
    const inFlight = new Set<string>();
    const streamingChats = new Set<string>();

    // Preflight returns context bound to a chat session and verifies the
    // worktree is in a state where push is meaningful. R surfaces
    // DbService so callers (under AppRuntime) get it for free.
    const preflight = (params: { readonly prId: string; readonly userId: string }) =>
      Effect.gen(function* () {
        if (streamingChats.has(params.prId)) {
          return yield* Effect.fail(new ChatStreamingConflictError({ prId: params.prId }));
        }

        const { pr, repo, token } = yield* prCtx.resolveBasic(params.prId, params.userId);

        if (!pr.headSha) {
          return yield* Effect.fail(
            new GitOperationError({
              message: "PR has no head SHA recorded yet — wait for the next sync",
            }),
          );
        }

        // Find a chat session for the PR's current head SHA. Try both
        // agent flavors — pick whichever one has commits.
        const opencodeSession = yield* chatSessions.find(pr.id, "opencode", pr.headSha);
        const claudeSession = yield* chatSessions.find(pr.id, "claude", pr.headSha);
        const session = opencodeSession ?? claudeSession;
        if (!session) {
          return yield* Effect.fail(new NoChatSessionError({ prId: params.prId }));
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
            revListCount(session.worktreePath, `${session.prHeadSha}..${session.branchName}`),
          catch: (err) =>
            new GitOperationError({
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        });
        const aheadCount = Number.parseInt(aheadOut.trim(), 10);
        if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
          return yield* Effect.fail(new NoChangesError({ prId: params.prId }));
        }

        return { pr, repo, token, session, aheadCount };
      });

    const fetchSourceBranch = (params: {
      worktreePath: string;
      authedUrl: string;
      sourceBranch: string;
    }) =>
      Effect.tryPromise({
        try: () =>
          fetchRefspec(
            params.worktreePath,
            params.authedUrl,
            `+refs/heads/${params.sourceBranch}:refs/remotes/origin/${params.sourceBranch}`,
          ),
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

    const restoreToAgentBranch = (params: { worktreePath: string; branchName: string }) =>
      Effect.promise(async () => {
        const ok = await checkoutBranchBestEffort(params.worktreePath, params.branchName, 15_000);
        if (!ok) {
          logError("chat-push", `failed to restore worktree to ${params.branchName}`);
        }
      });

    const restoreAgentBranchToTip = (params: {
      worktreePath: string;
      branchName: string;
      newTip: string;
    }) =>
      Effect.tryPromise({
        try: async () => {
          await forceBranchTo(params.worktreePath, params.branchName, params.newTip);
          await checkoutBranch(params.worktreePath, params.branchName);
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
        const result = await rebaseOnto(
          params.worktreePath,
          params.newTip,
          params.cherryPickedSha,
          params.oldAgentTip,
        );

        if (!result.ok) {
          await abortRebase(params.worktreePath);
          await forceBranchToBestEffort(
            params.worktreePath,
            params.branchName,
            params.oldAgentTip,
            5_000,
          );
          await checkoutBranchBestEffort(params.worktreePath, params.branchName, 10_000);
          logError(
            "cherry-pick",
            "rebase of remaining agent commits failed; restored agent branch to pre-cherry-pick tip",
          );
          return;
        }

        const rebasedTip = await revParse(params.worktreePath, "HEAD", 5_000).catch(() => null);
        if (!rebasedTip || !isValidSha(rebasedTip)) {
          await forceBranchToBestEffort(
            params.worktreePath,
            params.branchName,
            params.oldAgentTip,
            5_000,
          );
          await checkoutBranchBestEffort(params.worktreePath, params.branchName, 10_000);
          logError(
            "cherry-pick",
            "could not resolve HEAD after rebase; restored agent branch to pre-cherry-pick tip",
          );
          return;
        }

        await forceBranchTo(params.worktreePath, params.branchName, rebasedTip);
        await checkoutBranch(params.worktreePath, params.branchName);
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
        const fresh = yield* prService
          .listPrs()
          .pipe(Effect.map((prs) => prs.find((p) => p.id === params.pr.id) ?? null));
        if (fresh) {
          const metaOpt = yield* prCtx
            .prMeta(params.repo.fullName, params.prExternalId, params.token)
            .pipe(Effect.option);
          const headSha = metaOpt._tag === "Some" ? metaOpt.value.headSha : params.newTip;
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

        const pr = yield* prService.getPr(params.pr.id);
        const accountId = yield* prCtx.getAccountIdForRepo(pr.repositoryId);
        const prs = yield* prService.listPrs(accountId);
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "prs:updated",
          data: prs,
        });
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
                message: "git push rejected: token expired or insufficient scope",
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
          try: () => revParse(params.session.worktreePath, "HEAD", 10_000),
          catch: (err) =>
            new GitOperationError({
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        });
        const newTip = newTipOut;
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
          await checkoutNewBranchFromRef(
            params.worktreePath,
            params.sourceBranch,
            `refs/remotes/origin/${params.sourceBranch}`,
          );

          const mergeResult = await mergeBranch(params.worktreePath, params.branchName);

          if (mergeResult.ok) {
            return { status: "merged" } as const;
          }

          if (!isMergeInProgress(params.worktreePath)) {
            throw new Error(`git merge failed: ${mergeResult.stderr || "unknown error"}`);
          }

          const files = await unmergedPaths(params.worktreePath);
          if (params.abortOnConflict) {
            await abortMerge(params.worktreePath);
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
        readonly pr: { readonly id: string; readonly sourceBranch: string };
        readonly session: {
          readonly worktreePath: string;
          readonly branchName: string;
        };
        readonly aheadCount: number;
      };
      authedUrl: string;
      newBranchName: string;
      force: boolean;
    }): Effect.Effect<AttemptPushResult, ChatPushError, DbService> =>
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
            try: () => lsRemoteHead(params.ctx.session.worktreePath, params.authedUrl, trimmed),
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
                message: "git push rejected: token expired or insufficient scope",
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
            revParse(params.ctx.session.worktreePath, params.ctx.session.branchName, 10_000),
          catch: (err) =>
            new GitOperationError({
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        });
        const newTip = newTipOut;
        if (!isValidSha(newTip)) {
          return yield* Effect.fail(
            new GitOperationError({
              message: `invalid new tip from rev-parse: ${newTip}`,
            }),
          );
        }

        const pr = yield* prService.getPr(params.ctx.pr.id);
        const accountId = yield* prCtx.getAccountIdForRepo(pr.repositoryId);
        const prs = yield* prService.listPrs(accountId);
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "prs:updated",
          data: prs,
        });

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
      DbService | GitHubEtagCache | SettingsService
    > =>
      Effect.gen(function* () {
        yield* beginPush(params.prId);
        return yield* Effect.gen(function* () {
          const ctx = yield* preflight(params);
          const gitHost = yield* resolveGitHost;
          const authedUrl = `https://x-access-token:${ctx.token}@${gitHost}/${ctx.repo.fullName}.git`;

          if (params.newBranchName !== undefined) {
            return yield* pushToNewBranchEffect({
              ctx: {
                pr: { id: ctx.pr.id, sourceBranch: ctx.pr.sourceBranch },
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
            try: () => lsRemoteHead(ctx.session.worktreePath, authedUrl, ctx.pr.sourceBranch),
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
      DbService | GitHubEtagCache | SettingsService
    > =>
      Effect.gen(function* () {
        yield* beginPush(params.prId);

        // Resolve preflight + fetch up front so a hard error fails
        // the request synchronously rather than in the SSE stream.
        const ctx = yield* preflight(params).pipe(Effect.tapError(() => releasePush(params.prId)));

        const gitHost = yield* resolveGitHost;
        const authedUrl = `https://x-access-token:${ctx.token}@${gitHost}/${ctx.repo.fullName}.git`;

        yield* fetchSourceBranch({
          worktreePath: ctx.session.worktreePath,
          authedUrl,
          sourceBranch: ctx.pr.sourceBranch,
        }).pipe(Effect.tapError(() => releasePush(params.prId)));

        const expectedRemoteSha = yield* Effect.tryPromise({
          try: () => lsRemoteHead(ctx.session.worktreePath, authedUrl, ctx.pr.sourceBranch),
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

        const agentStream = yield* ai
          .resolveMergeConflict({
            cwd: ctx.session.worktreePath,
            agentBranch: ctx.session.branchName,
            sourceBranch: ctx.pr.sourceBranch,
            conflictFiles,
            prId: ctx.pr.id,
            userId: params.userId,
          })
          .pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                yield* Effect.promise(() =>
                  abortMerge(ctx.session.worktreePath).then(() => undefined),
                );
                yield* restoreToAgentBranch({
                  worktreePath: ctx.session.worktreePath,
                  branchName: ctx.session.branchName,
                });
                yield* releasePush(params.prId);
              }),
            ),
          );

        const queue = yield* Queue.unbounded<ResolvePushFrame>();

        yield* Effect.forkDaemon(
          Effect.gen(function* () {
            yield* Queue.offer(queue, {
              kind: "status",
              message: `Re-running merge into ${ctx.pr.sourceBranch}...`,
            });
            yield* Queue.offer(queue, { kind: "conflict-files", files: conflictFiles });
            yield* Queue.offer(queue, {
              kind: "status",
              message: "Asking the agent to resolve conflicts and run git merge --continue.",
            });

            const reader = agentStream.getReader();

            const readNext = (): Effect.Effect<
              { done: false; value: unknown } | { done: true },
              never
            > =>
              Effect.tryPromise({
                try: () =>
                  reader.read() as Promise<{ done: false; value: unknown } | { done: true }>,
                catch: () => ({ done: true }) as { done: true },
              }).pipe(Effect.orElseSucceed(() => ({ done: true }) as { done: true }));

            let chunk = yield* readNext();
            while (!chunk.done) {
              const value = chunk.value as { kind: string; [key: string]: unknown };
              if (value.kind === "text") {
                yield* Queue.offer(queue, { kind: "agent-text", data: value.data as string });
              } else if (value.kind === "activity") {
                yield* Queue.offer(queue, {
                  kind: "agent-activity",
                  activityKind: value.activityKind as string,
                  toolName: (value.toolName ?? null) as string | null,
                  summary: value.summary as string,
                  ...(value.payload !== undefined ? { payload: value.payload } : {}),
                });
              }
              chunk = yield* readNext();
            }

            if (isMergeInProgress(ctx.session.worktreePath)) {
              yield* Effect.promise(() =>
                abortMerge(ctx.session.worktreePath).then(() => undefined),
              );
              yield* restoreToAgentBranch({
                worktreePath: ctx.session.worktreePath,
                branchName: ctx.session.branchName,
              });
              yield* Queue.offer(queue, {
                kind: "result",
                status: "failed",
                message: "Agent finished but the merge is still in conflict. Aborting.",
              });
              return;
            }

            const cleanCheck = yield* Effect.tryPromise({
              try: () => workingTreeIsClean(ctx.session.worktreePath),
              catch: (err) => ({ clean: false, output: String(err) }),
            });
            if (!cleanCheck.clean) {
              yield* Effect.promise(() =>
                abortMerge(ctx.session.worktreePath).then(() => undefined),
              );
              yield* restoreToAgentBranch({
                worktreePath: ctx.session.worktreePath,
                branchName: ctx.session.branchName,
              });
              yield* Queue.offer(queue, {
                kind: "result",
                status: "failed",
                message: `Worktree has uncommitted changes after agent run:\n${cleanCheck.output}`,
              });
              return;
            }

            yield* Queue.offer(queue, { kind: "status", message: "Merge resolved. Pushing..." });

            const pushed = yield* completePush({
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

            if (pushed.status === "pushed") {
              yield* Queue.offer(queue, {
                kind: "result",
                status: "pushed",
                newSha: pushed.newSha,
                pushedCommits: pushed.pushedCommits,
                branch: pushed.branch,
              });
            } else if (pushed.status === "remote-changed") {
              yield* Queue.offer(queue, {
                kind: "result",
                status: "remote-changed",
                branch: pushed.branch,
              });
            } else {
              yield* Queue.offer(queue, {
                kind: "result",
                status: "failed",
                message: "Unexpected push outcome.",
              });
            }
          }).pipe(
            Effect.catchAll((err) =>
              Effect.gen(function* () {
                yield* Effect.promise(() =>
                  abortMerge(ctx.session.worktreePath).then(() => undefined),
                );
                yield* restoreToAgentBranch({
                  worktreePath: ctx.session.worktreePath,
                  branchName: ctx.session.branchName,
                });
                yield* Queue.offer(queue, {
                  kind: "result",
                  status: "failed",
                  message: String(err),
                });
              }),
            ),
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Queue.shutdown(queue).pipe(Effect.catchAll(() => Effect.void));
                yield* releasePush(params.prId);
              }),
            ),
          ),
        );

        return new ReadableStream<ResolvePushFrame>({
          async start(controller) {
            try {
              while (true) {
                const frame = await Effect.runPromise(Queue.take(queue));
                controller.enqueue(frame);
              }
            } catch {
              controller.close();
            }
          },
        });
      });

    const cherryPickAndPush = (params: {
      readonly prId: string;
      readonly userId: string;
      readonly sha: string;
    }): Effect.Effect<
      AttemptPushResult,
      ChatPushError,
      DbService | GitHubEtagCache | SettingsService
    > =>
      Effect.gen(function* () {
        yield* beginPush(params.prId);
        return yield* Effect.gen(function* () {
          const ctx = yield* preflight(params);
          const gitHost = yield* resolveGitHost;
          const authedUrl = `https://x-access-token:${ctx.token}@${gitHost}/${ctx.repo.fullName}.git`;

          // Validate SHA exists in worktree
          const fullShaOut = yield* Effect.tryPromise({
            try: () => revParse(ctx.session.worktreePath, params.sha, 5_000),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });
          const fullSha = fullShaOut;
          if (!isValidSha(fullSha)) {
            return yield* Effect.fail(
              new GitOperationError({ message: `Cannot resolve SHA: ${params.sha}` }),
            );
          }

          const expectedRemoteSha = yield* Effect.tryPromise({
            try: () => lsRemoteHead(ctx.session.worktreePath, authedUrl, ctx.pr.sourceBranch),
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

          // Capture the agent branch tip before switching to the source branch,
          // so completePush can rebase the remaining commits onto the new tip.
          const savedAgentTipOut = yield* Effect.tryPromise({
            try: () => revParse(ctx.session.worktreePath, ctx.session.branchName, 5_000),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });
          const savedAgentTip = savedAgentTipOut;

          // Checkout source branch locally
          yield* Effect.tryPromise({
            try: () =>
              checkoutNewBranchFromRef(
                ctx.session.worktreePath,
                ctx.pr.sourceBranch,
                `refs/remotes/origin/${ctx.pr.sourceBranch}`,
              ),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });

          // Cherry-pick the single commit
          const cpResult = yield* Effect.tryPromise({
            try: () => cherryPick(ctx.session.worktreePath, fullSha),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });

          if (!cpResult.ok) {
            // Abort cherry-pick and restore worktree
            yield* Effect.tryPromise({
              try: () => abortCherryPick(ctx.session.worktreePath),
              catch: () => new GitOperationError({ message: "cherry-pick --abort failed" }),
            });
            yield* restoreToAgentBranch({
              worktreePath: ctx.session.worktreePath,
              branchName: ctx.session.branchName,
            });
            return yield* Effect.fail(
              new GitOperationError({ message: `Cherry-pick failed: ${cpResult.stderr}` }),
            );
          }

          return yield* completePush({
            pr: { id: ctx.pr.id, externalId: ctx.pr.externalId, sourceBranch: ctx.pr.sourceBranch },
            repo: { fullName: ctx.repo.fullName },
            token: ctx.token,
            session: {
              id: ctx.session.id,
              worktreePath: ctx.session.worktreePath,
              branchName: ctx.session.branchName,
            },
            authedUrl,
            expectedRemoteSha,
            aheadCount: 1,
            cherryPickRebase: { cherryPickedSha: fullSha, oldAgentTip: savedAgentTip },
          });
        }).pipe(Effect.ensuring(releasePush(params.prId)));
      });

    // After cherry-picking N commits, rebuild the agent branch on top of the
    // new source-branch tip. Using `prHeadSha` (the session baseline) as the
    // rebase upstream replays every agent commit; git skips the cherry-picked
    // ones automatically via patch-id detection.
    const rebaseAgentBranchAfterBatchCherryPick = (params: {
      worktreePath: string;
      branchName: string;
      newTip: string;
      prHeadSha: string;
      oldAgentTip: string;
    }) =>
      Effect.promise(async () => {
        const result = await rebaseOnto(
          params.worktreePath,
          params.newTip,
          params.prHeadSha,
          params.oldAgentTip,
        );

        if (!result.ok) {
          await abortRebase(params.worktreePath);
          await forceBranchToBestEffort(
            params.worktreePath,
            params.branchName,
            params.oldAgentTip,
            5_000,
          );
          await checkoutBranchBestEffort(params.worktreePath, params.branchName, 10_000);
          logError(
            "batch-cherry-pick",
            "rebase of remaining agent commits failed; restored agent branch to pre-cherry-pick tip",
          );
          return;
        }

        const rebasedTip = await revParse(params.worktreePath, "HEAD", 5_000).catch(() => null);
        if (!rebasedTip || !isValidSha(rebasedTip)) {
          await forceBranchToBestEffort(
            params.worktreePath,
            params.branchName,
            params.oldAgentTip,
            5_000,
          );
          await checkoutBranchBestEffort(params.worktreePath, params.branchName, 10_000);
          logError(
            "batch-cherry-pick",
            "could not resolve HEAD after rebase; restored agent branch to pre-cherry-pick tip",
          );
          return;
        }

        await forceBranchTo(params.worktreePath, params.branchName, rebasedTip);
        await checkoutBranch(params.worktreePath, params.branchName);
      });

    const batchCherryPickAndPush = (params: {
      readonly prId: string;
      readonly userId: string;
      readonly shas: readonly string[];
    }): Effect.Effect<
      AttemptPushResult,
      ChatPushError,
      DbService | GitHubEtagCache | SettingsService
    > =>
      Effect.gen(function* () {
        if (params.shas.length === 0) {
          return yield* Effect.fail(new NoChangesError({ prId: params.prId }));
        }
        for (const sha of params.shas) {
          if (!isValidSha(sha)) {
            return yield* Effect.fail(new GitOperationError({ message: `Invalid SHA: ${sha}` }));
          }
        }

        yield* beginPush(params.prId);
        return yield* Effect.gen(function* () {
          const ctx = yield* preflight(params);
          const gitHost = yield* resolveGitHost;
          const authedUrl = `https://x-access-token:${ctx.token}@${gitHost}/${ctx.repo.fullName}.git`;

          // Resolve and order the SHAs chronologically (oldest first) so the
          // cherry-pick sequence matches the natural commit order on the
          // agent branch.
          const orderedListOut = yield* Effect.tryPromise({
            try: () =>
              revListReverse(
                ctx.session.worktreePath,
                `${ctx.session.prHeadSha}..${ctx.session.branchName}`,
              ),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });
          const orderedAll = orderedListOut;

          // Map requested SHAs (possibly abbreviated) to full SHAs and
          // intersect with the ordered list to preserve chronological order.
          const requestedFullShas = new Set<string>();
          for (const sha of params.shas) {
            const full = yield* Effect.tryPromise({
              try: () => revParse(ctx.session.worktreePath, sha, 5_000),
              catch: (err) =>
                new GitOperationError({
                  message: err instanceof Error ? err.message : String(err),
                  cause: err,
                }),
            });
            const trimmed = full;
            if (!isValidSha(trimmed)) {
              return yield* Effect.fail(
                new GitOperationError({ message: `Cannot resolve SHA: ${sha}` }),
              );
            }
            requestedFullShas.add(trimmed);
          }
          const orderedSelected = orderedAll.filter((s) => requestedFullShas.has(s));
          if (orderedSelected.length === 0) {
            return yield* Effect.fail(new NoChangesError({ prId: params.prId }));
          }

          const expectedRemoteSha = yield* Effect.tryPromise({
            try: () => lsRemoteHead(ctx.session.worktreePath, authedUrl, ctx.pr.sourceBranch),
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

          const savedAgentTipOut = yield* Effect.tryPromise({
            try: () => revParse(ctx.session.worktreePath, ctx.session.branchName, 5_000),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });
          const savedAgentTip = savedAgentTipOut;

          // Checkout source branch locally so cherry-picks land on it.
          yield* Effect.tryPromise({
            try: () =>
              checkoutNewBranchFromRef(
                ctx.session.worktreePath,
                ctx.pr.sourceBranch,
                `refs/remotes/origin/${ctx.pr.sourceBranch}`,
              ),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });

          // Cherry-pick each selected commit in chronological order.
          for (const sha of orderedSelected) {
            const cpResult = yield* Effect.tryPromise({
              try: () => cherryPick(ctx.session.worktreePath, sha),
              catch: (err) =>
                new GitOperationError({
                  message: err instanceof Error ? err.message : String(err),
                  cause: err,
                }),
            });
            if (!cpResult.ok) {
              yield* Effect.promise(() => abortCherryPick(ctx.session.worktreePath));
              yield* restoreToAgentBranch({
                worktreePath: ctx.session.worktreePath,
                branchName: ctx.session.branchName,
              });
              return yield* Effect.fail(
                new GitOperationError({
                  message: `Cherry-pick failed on ${sha.slice(0, 8)}: ${cpResult.stderr}`,
                }),
              );
            }
          }

          // Push the source branch (now containing the cherry-picked commits)
          // and rebuild the agent branch on top of the new tip, dropping the
          // cherry-picked commits via git's patch-id skip.
          const pushResult = yield* Effect.tryPromise({
            try: () =>
              expectedRemoteSha
                ? pushWithLease(
                    ctx.session.worktreePath,
                    authedUrl,
                    "HEAD",
                    ctx.pr.sourceBranch,
                    expectedRemoteSha,
                  )
                : pushFastForward(ctx.session.worktreePath, authedUrl, "HEAD", ctx.pr.sourceBranch),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });

          if (!pushResult.ok) {
            const stderr = pushResult.stderr.toLowerCase();
            yield* restoreToAgentBranch({
              worktreePath: ctx.session.worktreePath,
              branchName: ctx.session.branchName,
            });
            if (
              stderr.includes("stale info") ||
              stderr.includes("non-fast-forward") ||
              stderr.includes("rejected") ||
              stderr.includes("fetch first")
            ) {
              return {
                status: "remote-changed" as const,
                branch: ctx.pr.sourceBranch,
              };
            }
            if (
              stderr.includes("authentication") ||
              stderr.includes("403") ||
              stderr.includes("401")
            ) {
              return yield* Effect.fail(
                new GitHubAuthError({
                  message: "git push rejected: token expired or insufficient scope",
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
            try: () => revParse(ctx.session.worktreePath, "HEAD", 10_000),
            catch: (err) =>
              new GitOperationError({
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          });
          const newTip = newTipOut;
          if (!isValidSha(newTip)) {
            return yield* Effect.fail(
              new GitOperationError({
                message: `invalid new tip from rev-parse: ${newTip}`,
              }),
            );
          }

          yield* rebaseAgentBranchAfterBatchCherryPick({
            worktreePath: ctx.session.worktreePath,
            branchName: ctx.session.branchName,
            newTip,
            prHeadSha: ctx.session.prHeadSha,
            oldAgentTip: savedAgentTip,
          });

          yield* finalizeStateAfterPush({
            pr: { id: ctx.pr.id },
            repo: { fullName: ctx.repo.fullName },
            prExternalId: ctx.pr.externalId,
            token: ctx.token,
            sessionId: ctx.session.id,
            newTip,
          });

          return {
            status: "pushed" as const,
            newSha: newTip,
            pushedCommits: orderedSelected.length,
            branch: ctx.pr.sourceBranch,
          };
        }).pipe(Effect.ensuring(releasePush(params.prId)));
      });

    return {
      attemptMergeAndPush,
      resolveConflictsAndPush,
      cherryPickAndPush,
      batchCherryPickAndPush,
      isPushing: (prId: string) => inFlight.has(prId),
      markChatStreaming: (prId: string, streaming: boolean) => {
        if (streaming) streamingChats.add(prId);
        else streamingChats.delete(prId);
      },
      isChatStreaming: (prId: string) => streamingChats.has(prId),
    };
  }),
);
