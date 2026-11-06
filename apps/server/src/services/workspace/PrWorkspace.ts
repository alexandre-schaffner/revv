// ── PrWorkspace ────────────────────────────────────────────────────────────
//
// The one owner of a PR's agent workspace: the worktree `<holder>/pr-N` on the
// agent branch `revv/pr-N`, where the chat agent works and commits. Everything
// that touches it goes through here:
//
//   - the claim: one chat turn, push or commit edit at a time, refused up
//     front (`WorkspaceBusyError`) rather than racing in the worktree;
//   - which chat session is the PR's: the one for the current chat launch at
//     the PR's head, read the same way by the timeline, the turn and the push;
//   - the agent branch's baseline and proposed commits;
//   - every operation on those commits: listing, discarding, rebasing, pushing.
//
// Walkthrough generation never reads this worktree: each job checks out its
// own (`RepoClone.acquireReviewWorktree`).

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProposedCommit, ResolvePushFrame } from "@revv/shared";
import { Context, Effect, Layer, type Scope } from "effect";
import { resolveAgentLaunch } from "../../ai/acp/agent-launch";
import { CHAT_TURN } from "../../ai/acp/run-turn";
import {
  AgentBranchConflictError,
  type CloneError,
  type CloneNotReadyError,
  type DbError,
  GitOperationError,
  NoChatSessionError,
  NotFoundError,
  ValidationError,
  WorkspaceBusyError,
  type WorkspaceHolder,
  WorktreeBlockedByUnpushedCommits,
} from "../../domain/errors";
import { logError } from "../../logger";
import { AiService } from "../Ai";
import { type ChatSessionRow, ChatSessionService } from "../ChatSession";
import { worktreeHolderPath } from "../clone-policy";
import type { DbService } from "../Db";
import { BranchPushLock } from "../git/branch-push-lock";
import { assertNotFlagLike, commitPatch, fetch, isValidSha, resolveRef } from "../git/ops";
import { agentBranch, agentWorktreeDir } from "../git/pr-refs";
import { authedRemoteUrl } from "../git/remote";
import { type PrContextBasic, type PrContextError, PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import { RepoCloneService } from "../RepoClone";
import type { SettingsService } from "../Settings";
import {
  type AgentBranch,
  type CommitFile,
  commitFiles,
  commitsStrandedBy,
  countProposed,
  dropProposedCommits,
  listProposedCommits,
  replayAgentCommits,
  resetToBase,
  resolveBaseSha,
} from "./agent-branch";
import { createWorkspaceClaims, type WorkspaceClaim } from "./claims";
import { type AttemptPushResult, type ChatPushError, makeAgentPush } from "./push";

export interface ProposedChanges {
  readonly branchName: string | null;
  /** What the commits are measured from: a PR head, not necessarily the current one. */
  readonly baseSha: string | null;
  readonly commits: readonly ProposedCommit[];
}

type ReadError = PrContextError | DbError | NoChatSessionError;
type EditError =
  | ReadError
  | WorkspaceBusyError
  | ValidationError
  | NotFoundError
  | AgentBranchConflictError
  | GitOperationError
  | CloneError
  | CloneNotReadyError
  | WorktreeBlockedByUnpushedCommits;

export class PrWorkspace extends Context.Service<
  PrWorkspace,
  {
    /** Hold the PR's workspace until the scope closes; refused while anyone else does. */
    readonly claim: (
      prId: string,
      holder: WorkspaceHolder,
    ) => Effect.Effect<WorkspaceClaim, WorkspaceBusyError, Scope.Scope>;
    /** Claim the workspace and bring its worktree to `headSha` (or a descendant: the agent's commits). */
    readonly open: (
      ctx: PrContextBasic,
      headSha: string,
      holder: WorkspaceHolder,
    ) => Effect.Effect<
      { readonly claim: WorkspaceClaim; readonly branch: AgentBranch },
      | WorkspaceBusyError
      | WorktreeBlockedByUnpushedCommits
      | CloneError
      | CloneNotReadyError
      | DbError,
      Scope.Scope
    >;
    /** The PR's agent worktree and branch, if the agent ever worked on it. */
    readonly agentBranch: (ctx: PrContextBasic) => AgentBranch | null;
    /** The PR's chat session: the current chat launch's, at `pr.headSha`. */
    readonly session: (pr: {
      readonly id: string;
      readonly headSha: string | null;
    }) => Effect.Effect<ChatSessionRow | null, DbError>;
    /** How many proposed commits wait on the agent branch. */
    readonly unpushedCount: (ctx: PrContextBasic) => Effect.Effect<number, DbError>;
    readonly proposed: (prId: string) => Effect.Effect<ProposedChanges, ReadError>;
    readonly commitPatch: (
      prId: string,
      sha: string,
    ) => Effect.Effect<string, ReadError | ValidationError | GitOperationError>;
    readonly commitFiles: (
      prId: string,
      sha: string,
    ) => Effect.Effect<readonly CommitFile[], ReadError | ValidationError | GitOperationError>;
    /** Drop proposed commits, rebuilding the agent branch without them. */
    readonly discard: (
      prId: string,
      shas: readonly string[],
    ) => Effect.Effect<{ readonly discardedCount: number }, EditError>;
    /** Replay the agent's commits from `oldHeadSha` onto `newHeadSha`. */
    readonly rebaseOnto: (
      prId: string,
      oldHeadSha: string,
      newHeadSha: string,
    ) => Effect.Effect<void, EditError>;
    /** Move the worktree to `newHeadSha` once the agent's commits are handled. */
    readonly advance: (prId: string, newHeadSha: string) => Effect.Effect<void, EditError>;
    /** Delete the PR's conversations and rewind the agent branch to its baseline. */
    readonly clear: (prId: string) => Effect.Effect<void, EditError>;
    readonly mergeAndPush: (params: {
      readonly prId: string;
      readonly newBranchName?: string;
      readonly force?: boolean;
    }) => Effect.Effect<AttemptPushResult, ChatPushError>;
    readonly resolveAndPush: (
      prId: string,
    ) => Effect.Effect<ReadableStream<ResolvePushFrame>, ChatPushError>;
    readonly cherryPickAndPush: (params: {
      readonly prId: string;
      readonly shas: readonly string[];
    }) => Effect.Effect<AttemptPushResult, ChatPushError>;
  }
>()("PrWorkspace") {}

export const PrWorkspaceLive = Layer.effect(
  PrWorkspace,
  Effect.gen(function* () {
    const context = yield* Effect.context<DbService | SettingsService>();
    const prCtx = yield* PrContextService;
    const chatSessions = yield* ChatSessionService;
    const repoClone = yield* RepoCloneService;
    const pushLock = yield* BranchPushLock;
    const ai = yield* AiService;
    const mirror = yield* PrMirror;

    // A claim outlives its holder's idle deadline only if the holder leaked
    // it: past that, the agent turn has already been cancelled upstream.
    const claims = createWorkspaceClaims(CHAT_TURN.idleMs);

    const claim = (prId: string, holder: WorkspaceHolder) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const taken = claims.take(prId, holder);
          return typeof taken === "string"
            ? Effect.fail(new WorkspaceBusyError({ prId, heldBy: taken }))
            : Effect.succeed(taken);
        }),
        (held) => Effect.sync(held.release),
      );

    const agentBranchOf = ({ pr, repo }: PrContextBasic): AgentBranch | null => {
      const worktreePath = join(
        worktreeHolderPath(repo.owner, repo.name),
        agentWorktreeDir(pr.externalId),
      );
      return existsSync(worktreePath)
        ? { worktreePath, branchName: agentBranch(pr.externalId) }
        : null;
    };

    const requireBranch = (ctx: PrContextBasic) => {
      const branch = agentBranchOf(ctx);
      return branch
        ? Effect.succeed(branch)
        : Effect.fail(new NoChatSessionError({ prId: ctx.pr.id }));
    };

    const baselineOf = (ctx: PrContextBasic, branch: AgentBranch) =>
      Effect.gen(function* () {
        const pinned = yield* chatSessions.baselinesForPr(ctx.pr.id);
        const candidates = ctx.pr.headSha ? [...pinned, ctx.pr.headSha] : pinned;
        return yield* Effect.promise(() => resolveBaseSha(branch, candidates));
      });

    const session = (pr: { readonly id: string; readonly headSha: string | null }) =>
      Effect.gen(function* () {
        if (!pr.headSha) return null;
        const { agent, model } = yield* resolveAgentLaunch("chat").pipe(Effect.provide(context));
        return yield* chatSessions.find(pr.id, agent, model, pr.headSha);
      });

    const validShas = (shas: readonly string[]) => {
      const invalid = shas.find((sha) => !isValidSha(sha));
      return invalid === undefined
        ? Effect.void
        : Effect.fail(new ValidationError({ message: `Invalid commit SHA: ${invalid}` }));
    };

    /** Run `edit` holding the workspace, on the PR's agent branch. */
    const editBranch = <A, E>(
      prId: string,
      edit: (ctx: PrContextBasic, branch: AgentBranch) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* claim(prId, "branch-edit");
          const ctx = yield* prCtx.forPr(prId);
          return yield* edit(ctx, yield* requireBranch(ctx));
        }),
      );

    /**
     * Bring the agent worktree to `headSha`, refusing when that would throw
     * away the agent's unpushed commits (the PR moved underneath them). The
     * way out is `rebaseOnto` or `discard`, then `advance`.
     */
    const acquireAgentWorktree = (ctx: PrContextBasic, headSha: string) =>
      Effect.gen(function* () {
        const branch = agentBranchOf(ctx);
        if (branch) {
          const pinned = yield* chatSessions.baselinesForPr(ctx.pr.id);
          const stranded = yield* Effect.promise(() => commitsStrandedBy(branch, headSha, pinned));
          if (stranded) {
            return yield* Effect.fail(
              new WorktreeBlockedByUnpushedCommits({
                worktreePath: branch.worktreePath,
                branchName: branch.branchName,
                oldHeadSha: stranded.oldHeadSha,
                newHeadSha: headSha,
                commits: stranded.commits,
              }),
            );
          }
        }
        return yield* repoClone.acquirePrWorktree({
          repoId: ctx.repo.id,
          prNumber: ctx.pr.externalId,
          prHeadSha: headSha,
          githubToken: ctx.client.token,
        });
      });

    const push = makeAgentPush({
      resolve: (prId) => prCtx.forPr(prId),
      claim,
      pushLock,
      agentBranchOf,
      baselineOf,
      sessionOf: session,
      chatSessions,
      ai,
      mirror,
    });

    return {
      claim,

      open: (ctx, headSha, holder) =>
        Effect.gen(function* () {
          const held = yield* claim(ctx.pr.id, holder);
          return { claim: held, branch: yield* acquireAgentWorktree(ctx, headSha) };
        }),

      agentBranch: agentBranchOf,
      session,

      unpushedCount: (ctx) =>
        Effect.gen(function* () {
          const branch = agentBranchOf(ctx);
          if (!branch) return 0;
          const baseSha = yield* baselineOf(ctx, branch);
          return baseSha ? yield* Effect.promise(() => countProposed(branch, baseSha)) : 0;
        }),

      proposed: (prId) =>
        Effect.gen(function* () {
          const ctx = yield* prCtx.forPr(prId);
          const branch = agentBranchOf(ctx);
          if (!branch) return { branchName: null, baseSha: null, commits: [] };
          const baseSha = yield* baselineOf(ctx, branch);
          if (!baseSha) return { branchName: branch.branchName, baseSha: null, commits: [] };
          const commits = yield* Effect.promise(() =>
            listProposedCommits(branch, baseSha).catch((err) => {
              logError("chat", "listing proposed commits failed:", err);
              return [];
            }),
          );
          return { branchName: branch.branchName, baseSha, commits };
        }),

      commitPatch: (prId, sha) =>
        Effect.gen(function* () {
          yield* validShas([sha]);
          const branch = yield* requireBranch(yield* prCtx.forPr(prId));
          return yield* Effect.tryPromise({
            try: () => commitPatch(branch.worktreePath, sha),
            catch: (err) => new GitOperationError({ message: String(err), cause: err }),
          });
        }),

      commitFiles: (prId, sha) =>
        Effect.gen(function* () {
          yield* validShas([sha]);
          const branch = yield* requireBranch(yield* prCtx.forPr(prId));
          return yield* Effect.tryPromise({
            try: () => commitFiles(branch.worktreePath, sha),
            catch: (err) => new GitOperationError({ message: String(err), cause: err }),
          });
        }),

      discard: (prId, shas) =>
        Effect.gen(function* () {
          yield* validShas(shas);
          return yield* editBranch(prId, (ctx, branch) =>
            Effect.gen(function* () {
              const drop = new Set<string>();
              for (const sha of shas) {
                const full = yield* Effect.promise(() => resolveRef(branch.worktreePath, sha));
                if (!full)
                  return yield* Effect.fail(new NotFoundError({ resource: "commit", id: sha }));
                drop.add(full);
              }
              const baseSha = yield* baselineOf(ctx, branch);
              if (!baseSha) {
                return yield* Effect.fail(
                  new NotFoundError({ resource: "commit", id: shas.join(",") }),
                );
              }
              const dropped = yield* Effect.promise(() =>
                dropProposedCommits(branch, baseSha, drop),
              );
              switch (dropped.kind) {
                case "dropped":
                  return { discardedCount: dropped.count };
                case "none-matched":
                  return yield* Effect.fail(
                    new NotFoundError({ resource: "proposed commit", id: shas.join(",") }),
                  );
                case "conflict":
                  return yield* Effect.fail(
                    new AgentBranchConflictError({ message: dropped.message }),
                  );
                case "failed":
                  return yield* Effect.fail(new GitOperationError({ message: dropped.message }));
              }
            }),
          );
        }),

      rebaseOnto: (prId, oldHeadSha, newHeadSha) =>
        Effect.gen(function* () {
          yield* validShas([oldHeadSha, newHeadSha]);
          yield* editBranch(prId, (ctx, branch) =>
            Effect.gen(function* () {
              const { repo } = ctx;
              const token = ctx.client.token;
              yield* Effect.promise(() =>
                fetch(
                  branch.worktreePath,
                  authedRemoteUrl({ host: repo.githubHost, fullName: repo.fullName, token }),
                  [newHeadSha],
                ),
              );
              const oldTip = yield* Effect.promise(() =>
                resolveRef(branch.worktreePath, branch.branchName),
              );
              if (!oldTip) {
                return yield* Effect.fail(
                  new GitOperationError({ message: "Couldn't read the agent branch" }),
                );
              }
              const replayed = yield* Effect.promise(() =>
                replayAgentCommits(branch, { onto: newHeadSha, upstream: oldHeadSha, oldTip }),
              );
              if (!replayed.ok) {
                return yield* Effect.fail(
                  replayed.kind === "conflict"
                    ? new AgentBranchConflictError({ message: replayed.message })
                    : new GitOperationError({ message: replayed.message }),
                );
              }
            }),
          );
        }),

      advance: (prId, newHeadSha) =>
        Effect.gen(function* () {
          yield* validShas([newHeadSha]);
          yield* Effect.try({
            try: () => assertNotFlagLike(newHeadSha, "newHeadSha"),
            catch: (err) => new ValidationError({ message: String(err) }),
          });
          yield* editBranch(prId, (ctx) =>
            Effect.gen(function* () {
              yield* acquireAgentWorktree(ctx, newHeadSha);
              // The conversation the block interrupted continues at the new head.
              const { agent, model } = yield* resolveAgentLaunch("chat").pipe(
                Effect.provide(context),
              );
              const interrupted = yield* chatSessions.findLatest(ctx.pr.id, agent, model);
              if (interrupted) {
                yield* chatSessions.updatePrHeadSha({
                  chatSessionId: interrupted.id,
                  prHeadSha: newHeadSha,
                });
              }
            }),
          );
        }),

      clear: (prId) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* claim(prId, "branch-edit");
            const ctx = yield* prCtx.forPr(prId);
            const branch = agentBranchOf(ctx);
            // Read the baseline before the sessions that pin it go.
            const baseSha = branch ? yield* baselineOf(ctx, branch) : null;
            yield* chatSessions.clearForPr(ctx.pr.id);
            if (branch && baseSha) yield* Effect.promise(() => resetToBase(branch, baseSha));
          }),
        ),

      mergeAndPush: (params) => push.mergeAndPush(params).pipe(Effect.provide(context)),
      resolveAndPush: (prId) => push.resolveAndPush(prId).pipe(Effect.provide(context)),
      cherryPickAndPush: (params) => push.cherryPickAndPush(params).pipe(Effect.provide(context)),
    };
  }),
);
