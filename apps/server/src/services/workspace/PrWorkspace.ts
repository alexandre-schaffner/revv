// The one owner of a PR's agent workspace: the worktree on the agent branch
// (`agent-worktrees.ts`), where the chat agent works and commits, and the
// chat session that goes with it. Everything that touches it goes through
// here:
//
//   - the claim: one chat turn, push or commit edit at a time, refused up
//     front (`WorkspaceBusyError`) rather than racing in the worktree;
//   - which chat session is the PR's: the one for the current chat launch at
//     the PR's head (the mirror's, recorded from GitHub first when it has
//     none), read the same way by the timeline, the turn and the push;
//   - the agent branch's baseline and proposed commits;
//   - every operation on those commits: listing, discarding, rebasing, pushing.
//
// Walkthrough generation never reads this worktree: each job checks out its
// own (`RepoClone.acquireReviewWorktree`).

import type { ProposedCommit, ResolvePushFrame } from "@revv/shared";
import { Context, Effect, Layer, type Scope } from "effect";
import { type AgentLaunch, resolveAgentLaunch } from "../../ai/acp/agent-launch";
import {
  AgentBranchConflictError,
  type CloneError,
  type CloneNotReadyError,
  type DbError,
  type GitHubError,
  GitOperationError,
  NoChatSessionError,
  NotFoundError,
  ValidationError,
  type WorkspaceBusyError,
  type WorkspaceHolder,
  WorktreeBlockedByUnpushedCommits,
} from "../../domain/errors";
import { AiService } from "../Ai";
import { type ChatSessionRow, ChatSessionService } from "../chat/ChatSession";
import { BranchPushLock } from "../git/branch-push-lock";
import { assertNotFlagLike, fetch, gitTry, isValidSha, resolveRef } from "../git/ops";
import { authedRemoteUrl } from "../git/remote";
import { type PrContextBasic, type PrContextError, PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import type { SettingsService } from "../Settings";
import {
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
import { type AgentBranch, AgentWorktrees } from "./agent-worktrees";
import type { WorkspaceClaim } from "./claims";
import { type AttemptPushResult, type ChatPushError, makeAgentPush } from "./push";

export interface ProposedChanges {
  readonly branchName: string | null;
  /** What the commits are measured from: a PR head, not necessarily the current one. */
  readonly baseSha: string | null;
  readonly commits: readonly ProposedCommit[];
}

type ReadError = PrContextError | DbError | NoChatSessionError | GitOperationError;
type EditError =
  | ReadError
  | WorkspaceBusyError
  | ValidationError
  | NotFoundError
  | AgentBranchConflictError
  | CloneError
  | CloneNotReadyError
  | WorktreeBlockedByUnpushedCommits;

export type OpenError =
  | WorkspaceBusyError
  | WorktreeBlockedByUnpushedCommits
  | CloneError
  | CloneNotReadyError
  | GitOperationError
  | GitHubError
  | DbError;

export class PrWorkspace extends Context.Service<
  PrWorkspace,
  {
    /**
     * Claim the workspace and bring its worktree to the PR's head (or a
     * descendant: the agent's commits).
     */
    readonly open: (
      ctx: PrContextBasic,
      holder: WorkspaceHolder,
    ) => Effect.Effect<
      { readonly claim: WorkspaceClaim; readonly branch: AgentBranch; readonly headSha: string },
      OpenError,
      Scope.Scope
    >;
    /** The PR's chat session at `headSha` for the current chat launch, created on first use. */
    readonly openSession: (
      ctx: PrContextBasic,
      headSha: string,
      branch: AgentBranch,
    ) => Effect.Effect<{ readonly session: ChatSessionRow; readonly launch: AgentLaunch }, DbError>;
    /** The PR's agent worktree and branch, if the agent ever worked on it. */
    readonly agentBranch: (ctx: PrContextBasic) => AgentBranch | null;
    /** The PR's chat session: the current chat launch's, at `pr.headSha`. */
    readonly session: (pr: {
      readonly id: string;
      readonly headSha: string | null;
    }) => Effect.Effect<ChatSessionRow | null, DbError>;
    readonly unpushedCount: (
      ctx: PrContextBasic,
    ) => Effect.Effect<number, DbError | GitOperationError>;
    readonly proposed: (prId: string) => Effect.Effect<ProposedChanges, ReadError>;
    readonly commitFiles: (
      prId: string,
      sha: string,
    ) => Effect.Effect<readonly CommitFile[], ReadError | ValidationError>;
    readonly discard: (
      prId: string,
      shas: readonly string[],
    ) => Effect.Effect<{ readonly discardedCount: number }, EditError>;
    readonly rebaseOnto: (
      prId: string,
      oldHeadSha: string,
      newHeadSha: string,
    ) => Effect.Effect<void, EditError>;
    /** Move the worktree to `newHeadSha` once the agent's commits are handled. */
    readonly advance: (prId: string, newHeadSha: string) => Effect.Effect<void, EditError>;
    /** Rewind the agent branch to its baseline and delete the PR's conversations. */
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
    const context = yield* Effect.context<SettingsService>();
    const prCtx = yield* PrContextService;
    const chatSessions = yield* ChatSessionService;
    const worktrees = yield* AgentWorktrees;
    const pushLock = yield* BranchPushLock;
    const ai = yield* AiService;
    const mirror = yield* PrMirror;

    const chatLaunch = resolveAgentLaunch("chat").pipe(Effect.provide(context));

    const agentBranchOf = ({ pr, repo }: PrContextBasic) =>
      worktrees.locate(repo.id, pr.externalId);

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
        return yield* gitTry(() => resolveBaseSha(branch, candidates));
      });

    const session = (pr: { readonly id: string; readonly headSha: string | null }) =>
      Effect.gen(function* () {
        if (!pr.headSha) return null;
        const { agent, model } = yield* chatLaunch;
        return yield* chatSessions.find(pr.id, agent, model, pr.headSha);
      });

    /** The PR's conversation continues at `newHeadSha`: the latest session moves there. */
    const moveSession = (prId: string, newHeadSha: string) =>
      Effect.gen(function* () {
        const { agent, model } = yield* chatLaunch;
        const latest = yield* chatSessions.findLatest(prId, agent, model);
        if (latest) {
          yield* chatSessions.updatePrHeadSha({ chatSessionId: latest.id, prHeadSha: newHeadSha });
        }
      });

    const validShas = (shas: readonly string[]) => {
      const invalid = shas.find((sha) => !isValidSha(sha));
      return invalid === undefined
        ? Effect.void
        : Effect.fail(new ValidationError({ message: `Invalid commit SHA: ${invalid}` }));
    };

    const editBranch = <A, E>(
      prId: string,
      edit: (ctx: PrContextBasic, branch: AgentBranch, held: WorkspaceClaim) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const held = yield* worktrees.claim(prId, "branch-edit");
          const ctx = yield* prCtx.forPr(prId);
          return yield* edit(ctx, yield* requireBranch(ctx), held);
        }),
      );

    /**
     * Bring the agent worktree to `headSha`, refusing when that would throw
     * away the agent's unpushed commits (the PR moved underneath them). The
     * way out is `rebaseOnto` or `discard`, then `advance`.
     */
    const acquireAgentWorktree = (held: WorkspaceClaim, ctx: PrContextBasic, headSha: string) =>
      Effect.gen(function* () {
        const branch = agentBranchOf(ctx);
        if (branch) {
          const pinned = yield* chatSessions.baselinesForPr(ctx.pr.id);
          const stranded = yield* gitTry(() => commitsStrandedBy(branch, headSha, pinned));
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
        return yield* worktrees.ensure(held, {
          repoId: ctx.repo.id,
          prNumber: ctx.pr.externalId,
          prHeadSha: headSha,
          githubToken: ctx.client.token,
        });
      });

    const push = makeAgentPush({
      resolve: (prId) => prCtx.forPr(prId),
      claim: worktrees.claim,
      pushLock,
      agentBranchOf,
      baselineOf,
      moveSession,
      ai,
      mirror,
    });

    return {
      open: (ctx, holder) =>
        Effect.gen(function* () {
          const held = yield* worktrees.claim(ctx.pr.id, holder);
          const headSha = yield* mirror.headOf(ctx);
          const branch = yield* acquireAgentWorktree(held, ctx, headSha);
          return { claim: held, branch, headSha };
        }),

      openSession: (ctx, headSha, branch) =>
        Effect.gen(function* () {
          const launch = yield* chatLaunch;
          const row = yield* chatSessions.findOrCreate({
            prId: ctx.pr.id,
            agent: launch.agent,
            model: launch.model,
            prHeadSha: headSha,
            worktreePath: branch.worktreePath,
            branchName: branch.branchName,
          });
          return { session: row, launch };
        }),

      agentBranch: agentBranchOf,
      session,

      unpushedCount: (ctx) =>
        Effect.gen(function* () {
          const branch = agentBranchOf(ctx);
          if (!branch) return 0;
          const baseSha = yield* baselineOf(ctx, branch);
          return baseSha ? yield* gitTry(() => countProposed(branch, baseSha)) : 0;
        }),

      proposed: (prId) =>
        Effect.gen(function* () {
          const ctx = yield* prCtx.forPr(prId);
          const branch = agentBranchOf(ctx);
          if (!branch) return { branchName: null, baseSha: null, commits: [] };
          const baseSha = yield* baselineOf(ctx, branch);
          if (!baseSha) return { branchName: branch.branchName, baseSha: null, commits: [] };
          const commits = yield* gitTry(
            () => listProposedCommits(branch, baseSha),
            "Listing the agent's commits failed",
          );
          return { branchName: branch.branchName, baseSha, commits };
        }),

      commitFiles: (prId, sha) =>
        Effect.gen(function* () {
          yield* validShas([sha]);
          const branch = yield* requireBranch(yield* prCtx.forPr(prId));
          return yield* gitTry(() => commitFiles(branch.worktreePath, sha));
        }),

      discard: (prId, shas) =>
        Effect.gen(function* () {
          yield* validShas(shas);
          return yield* editBranch(prId, (ctx, branch) =>
            Effect.gen(function* () {
              const drop = new Set<string>();
              for (const sha of shas) {
                const full = yield* gitTry(() => resolveRef(branch.worktreePath, sha));
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
              const dropped = yield* gitTry(() => dropProposedCommits(branch, baseSha, drop));
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
              const fetched = yield* gitTry(() =>
                fetch(
                  branch.worktreePath,
                  authedRemoteUrl({
                    host: repo.githubHost,
                    fullName: repo.fullName,
                    token: ctx.client.token,
                  }),
                  [newHeadSha],
                ),
              );
              if (!fetched.ok) {
                return yield* Effect.fail(
                  new GitOperationError({
                    message: `Couldn't fetch the PR's new head: ${fetched.stderr || "git failed"}`,
                    stderr: fetched.stderr,
                  }),
                );
              }
              const oldTip = yield* gitTry(() =>
                resolveRef(branch.worktreePath, branch.branchName),
              );
              if (!oldTip) {
                return yield* Effect.fail(
                  new GitOperationError({ message: "Couldn't read the agent branch" }),
                );
              }
              const replayed = yield* gitTry(() =>
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
          yield* editBranch(prId, (ctx, _branch, held) =>
            Effect.gen(function* () {
              yield* acquireAgentWorktree(held, ctx, newHeadSha);
              // The conversation the block interrupted continues at the new head.
              yield* moveSession(ctx.pr.id, newHeadSha);
            }),
          );
        }),

      clear: (prId) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* worktrees.claim(prId, "branch-edit");
            const ctx = yield* prCtx.forPr(prId);
            const branch = agentBranchOf(ctx);
            // Rewound before the sessions that pin the baseline go: a clear
            // that couldn't rewind keeps the conversation it would orphan.
            if (branch) {
              const baseSha = yield* baselineOf(ctx, branch);
              const failed = baseSha ? yield* gitTry(() => resetToBase(branch, baseSha)) : null;
              if (failed) {
                return yield* Effect.fail(
                  new GitOperationError({
                    message: `Couldn't discard the agent's changes: ${failed}`,
                  }),
                );
              }
            }
            yield* chatSessions.clearForPr(ctx.pr.id);
          }),
        ),

      mergeAndPush: (params) => push.mergeAndPush(params).pipe(Effect.provide(context)),
      resolveAndPush: (prId) => push.resolveAndPush(prId).pipe(Effect.provide(context)),
      cherryPickAndPush: (params) => push.cherryPickAndPush(params).pipe(Effect.provide(context)),
    };
  }),
);
