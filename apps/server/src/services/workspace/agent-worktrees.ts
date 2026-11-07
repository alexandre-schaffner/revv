// A PR's agent worktree on disk: `<holder>/pr-N` on the agent branch
// `revv/pr-N` (see `clone/layout.ts`), and the claim that guards it. Every
// writer goes through the claim: a chat turn, a push or a commit edit
// (`PrWorkspace`), and the prune when the PR closes. So a chat turn still
// running on a just-merged PR keeps its worktree until it lets go; the prune
// is skipped, and the next sweep retries it.

import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer, type Scope } from "effect";
import { CHAT_TURN } from "../../ai/acp/run-turn";
import { pullRequests, repositories } from "../../db/schema/index";
import {
  type CloneError,
  type CloneNotReadyError,
  type DbError,
  WorkspaceBusyError,
  type WorkspaceHolder,
} from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { debug, logError } from "../../logger";
import { existingPathIsUnder } from "../clone/policy";
import {
  ensurePrCommitPresent,
  RepoCloneService,
  samePath,
  toCloneError,
} from "../clone/RepoClone";
import { DbService } from "../Db";
import {
  abortMerge,
  abortRebase,
  addWorktreeOnBranch,
  attachedBranch,
  deleteBranch,
  deleteRef,
  gitDirs,
  isAncestor,
  isMergeInProgress,
  isRebaseInProgress,
  listRefs,
  listWorktrees,
  moveWorktree,
  proposedCommitCount,
  removeWorktree,
  resetHard,
  resolveRef,
  updateRef,
} from "../git/ops";
import { agentBranch, agentBranchPr, legacyPrRef, prFetchRef, scratchRef } from "../git/pr-refs";
import { authedRemoteUrl } from "../git/remote";
import { createWorkspaceClaims, type WorkspaceClaim } from "./claims";

export interface AgentBranch {
  readonly worktreePath: string;
  readonly branchName: string;
}

/**
 * `pruned: false` means teardown was skipped: the agent branch carries
 * unpushed commits, someone holds the workspace, or the repo has no ready clone.
 */
export type PruneWorktreeOutcome =
  | { readonly pruned: true }
  | { readonly pruned: false; readonly reason: "unpushed-commits" | "busy" | "not-found" };

export class AgentWorktrees extends Context.Service<
  AgentWorktrees,
  {
    /** Hold the PR's workspace until the scope closes; refused while anyone else does. */
    readonly claim: (
      prId: string,
      holder: WorkspaceHolder,
    ) => Effect.Effect<WorkspaceClaim, WorkspaceBusyError, Scope.Scope>;
    /** The PR's agent worktree and branch, if the agent ever worked on it. */
    readonly locate: (repoId: string, prNumber: number) => AgentBranch | null;
    /**
     * Bring the agent worktree to `prHeadSha`, or leave it at a descendant of
     * it (the agent's unpushed commits). Created on first use. The caller
     * holds the PR's claim.
     *
     * An existing worktree on the branch at a descendant of `prHeadSha` is
     * returned untouched; one at another commit is reset to `prHeadSha`; one
     * on the wrong branch or broken is recreated.
     */
    readonly ensure: (
      held: WorkspaceClaim,
      params: {
        readonly repoId: string;
        readonly prNumber: number;
        readonly prHeadSha: string;
        readonly githubToken: string;
      },
    ) => Effect.Effect<AgentBranch, CloneError | CloneNotReadyError | DbError>;
    /**
     * Reap one PR's agent worktree, its branch and its fetch refs, under the
     * PR's claim. Refuses (`pruned: false`) while someone holds the claim, or
     * the branch carries commits beyond the recorded PR head, unless `force`.
     * Callers decide which PRs are eligible.
     */
    readonly prune: (params: {
      readonly repoId: string;
      readonly prId: string;
      readonly prNumber: number;
      readonly force?: boolean;
    }) => Effect.Effect<PruneWorktreeOutcome, CloneError | DbError>;
    /** Prune the agent branches of every ready repo whose PR is closed, merged or no longer tracked. */
    readonly sweep: () => Effect.Effect<
      { readonly scanned: number; readonly pruned: number; readonly keptUnpushed: number },
      DbError
    >;
  }
>()("AgentWorktrees") {}

/**
 * Lock files tied to one PR's worktree and its branch ref. A git command the
 * agent was running when its subprocess was killed can leave them behind, and
 * every later fetch or reset then fails with "Unable to create '…': File
 * exists". Repository-wide locks (packed-refs, shallow) are left alone: another
 * PR's job may legitimately hold them.
 */
async function prWorktreeLockPaths(worktreePath: string, branchName: string): Promise<string[]> {
  const dirs = await gitDirs(worktreePath);
  if (!dirs) return [];
  return [
    join(dirs.gitDir, "index.lock"),
    join(dirs.gitDir, "HEAD.lock"),
    join(dirs.commonDir, "refs", "heads", `${branchName}.lock`),
  ];
}

async function clearStalePrWorktreeLocks(worktreePath: string, branchName: string): Promise<void> {
  for (const lockPath of await prWorktreeLockPaths(worktreePath, branchName)) {
    try {
      if (!existsSync(lockPath)) continue;
      await rm(lockPath, { force: true });
      debug("pr-worktree", "cleared stale git lock:", lockPath);
    } catch (err) {
      logError(
        "pr-worktree",
        "failed to clear stale lock:",
        lockPath,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Whether an existing PR worktree can be reused as-is, answered with reads
 * only. `ensure` runs on every chat turn and composer warm-up, and its repair
 * path writes under `.git`, which fires a file-watcher event in any editor
 * that has the user's repository open. Only an unhealthy worktree should pay
 * that.
 */
export async function isWorktreeHealthy(params: {
  clonePath: string;
  branchName: string;
  worktreePath: string;
  prHeadSha: string;
  prNumber: number;
}): Promise<boolean> {
  const { clonePath, branchName, worktreePath, prHeadSha, prNumber } = params;
  if (!existsSync(worktreePath)) return false;
  if ((await isMergeInProgress(worktreePath)) || (await isRebaseInProgress(worktreePath))) {
    return false;
  }
  const locks = await prWorktreeLockPaths(worktreePath, branchName);
  if (locks.length === 0 || locks.some((lockPath) => existsSync(lockPath))) return false;
  if ((await resolveRef(clonePath, legacyPrRef(prNumber))) !== null) return false;
  if ((await attachedBranch(worktreePath)) !== `refs/heads/${branchName}`) return false;
  const currentSha = await resolveRef(worktreePath, "HEAD");
  if (currentSha === null) return false;
  return currentSha === prHeadSha || isAncestor(worktreePath, prHeadSha, currentSha);
}

/**
 * Bring the worktree at `worktreePath` to `prHeadSha` on `branchName`. Where
 * the branch is checked out elsewhere under Revv's base (an older layout, a
 * run killed mid-move), that worktree is moved into place, uncommitted edits
 * and all; one that can't be moved is a refusal, never a deletion. The
 * user's own worktrees live outside the base and are left alone.
 */
export async function bringWorktreeToHead(params: {
  readonly base: string;
  readonly clonePath: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly prNumber: number;
  readonly prHeadSha: string;
  readonly url: string;
}): Promise<void> {
  const { base, clonePath, worktreePath, branchName, prNumber, prHeadSha, url } = params;
  if (existsSync(worktreePath)) await clearStalePrWorktreeLocks(worktreePath, branchName);
  await deleteRef(clonePath, legacyPrRef(prNumber));

  // Leftovers of a push or branch edit that was killed mid-way.
  if (existsSync(worktreePath)) {
    await abortMerge(worktreePath);
    await abortRebase(worktreePath);
  }

  if (existsSync(worktreePath)) {
    if ((await attachedBranch(worktreePath)) === `refs/heads/${branchName}`) {
      const currentSha = await resolveRef(worktreePath, "HEAD");
      if (
        currentSha !== null &&
        (currentSha === prHeadSha || (await isAncestor(worktreePath, prHeadSha, currentSha)))
      ) {
        return;
      }
      await ensurePrCommitPresent(worktreePath, prHeadSha, prNumber, url);
      const reset = await resetHard(worktreePath, prHeadSha);
      if (!reset.ok) throw new Error(`git reset failed: ${reset.stderr}`);
      return;
    }
    await removeWorktree(clonePath, worktreePath);
    await rm(worktreePath, { recursive: true, force: true });
  }
  // A registration whose directory is already gone would make `worktree add` fail.
  await removeWorktree(clonePath, worktreePath);

  const ref = `refs/heads/${branchName}`;
  for (const other of await listWorktrees(clonePath)) {
    if (other.branch !== ref || samePath(other.path, worktreePath)) continue;
    if (!existsSync(other.path)) {
      await removeWorktree(clonePath, other.path);
      continue;
    }
    if (!existingPathIsUnder(other.path, base)) {
      throw new Error(
        `${branchName} is checked out at ${other.path}; Revv won't touch your worktree`,
      );
    }
    const moved = await moveWorktree(clonePath, other.path, worktreePath);
    if (!moved.ok) {
      throw new Error(
        `${branchName} is checked out at ${other.path}, and moving it failed: ${moved.stderr}`,
      );
    }
    return bringWorktreeToHead(params);
  }

  await ensurePrCommitPresent(clonePath, prHeadSha, prNumber, url);
  const fetched = await updateRef(clonePath, prFetchRef(prNumber), prHeadSha);
  if (!fetched.ok) throw new Error(`git update-ref failed: ${fetched.stderr}`);
  const added = await addWorktreeOnBranch(clonePath, worktreePath, branchName, prHeadSha);
  if (!added.ok) throw new Error(`git worktree add failed: ${added.stderr}`);
}

export const AgentWorktreesLive = Layer.effect(
  AgentWorktrees,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const repoClone = yield* RepoCloneService;
    const { layout } = repoClone;

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

    const locate = (repoId: string, prNumber: number): AgentBranch | null => {
      const worktreePath = layout.agentWorktree(repoId, prNumber);
      return existsSync(worktreePath) ? { worktreePath, branchName: agentBranch(prNumber) } : null;
    };

    const ensure = (
      _held: WorkspaceClaim,
      params: {
        readonly repoId: string;
        readonly prNumber: number;
        readonly prHeadSha: string;
        readonly githubToken: string;
      },
    ) =>
      Effect.gen(function* () {
        const { repoId, prNumber, prHeadSha, githubToken } = params;
        const { repo, clonePath } = yield* repoClone.readyClone(repoId);
        const branch = {
          worktreePath: layout.agentWorktree(repoId, prNumber),
          branchName: agentBranch(prNumber),
        };
        yield* Effect.tryPromise({
          try: async () => {
            if (await isWorktreeHealthy({ clonePath, ...branch, prHeadSha, prNumber })) return;
            mkdirSync(layout.holder(repoId), { recursive: true });
            await bringWorktreeToHead({
              base: layout.base,
              clonePath,
              ...branch,
              prNumber,
              prHeadSha,
              url: authedRemoteUrl({
                host: repo.githubHost,
                fullName: repo.fullName,
                token: githubToken,
              }),
            });
          },
          catch: toCloneError,
        });
        return branch;
      }).pipe(
        Effect.withSpan("AgentWorktrees.ensure", {
          attributes: { repoId: params.repoId, prNumber: params.prNumber },
        }),
      );

    const headShaOf = (repoId: string, prNumber: number) =>
      dbTry(
        "PR head read",
        () =>
          db
            .select({ headSha: pullRequests.headSha })
            .from(pullRequests)
            .where(
              and(eq(pullRequests.repositoryId, repoId), eq(pullRequests.externalId, prNumber)),
            )
            .get()?.headSha ?? null,
      );

    /** Tear down without the claim: for an untracked PR no one can hold it. */
    const reap = (params: {
      readonly repoId: string;
      readonly prNumber: number;
      readonly force: boolean;
    }) =>
      Effect.gen(function* () {
        const { repoId, prNumber, force } = params;
        const ready = yield* repoClone
          .readyClone(repoId)
          .pipe(Effect.catchTag("CloneNotReadyError", () => Effect.succeed(null)));
        if (ready === null) return { pruned: false, reason: "not-found" } as const;
        const { clonePath } = ready;
        const branchName = agentBranch(prNumber);
        const worktreePath = layout.agentWorktree(repoId, prNumber);
        const headSha = force ? null : yield* headShaOf(repoId, prNumber);
        return yield* Effect.tryPromise({
          try: async (): Promise<PruneWorktreeOutcome> => {
            const worktreeExists = existsSync(worktreePath);
            if (headSha) {
              const ahead = await proposedCommitCount(
                worktreeExists ? worktreePath : clonePath,
                `${headSha}..${branchName}`,
              );
              if ((ahead ?? 0) > 0) return { pruned: false, reason: "unpushed-commits" };
            }
            await removeWorktree(clonePath, worktreePath);
            if (existsSync(worktreePath)) await rm(worktreePath, { recursive: true, force: true });
            await deleteBranch(clonePath, branchName);
            await deleteRef(clonePath, prFetchRef(prNumber));
            await deleteRef(clonePath, legacyPrRef(prNumber));
            await deleteRef(clonePath, scratchRef("chat-push", prNumber, "source"));
            return { pruned: true };
          },
          catch: toCloneError,
        });
      });

    const prune = (params: {
      readonly repoId: string;
      readonly prId: string;
      readonly prNumber: number;
      readonly force?: boolean;
    }) =>
      Effect.scoped(
        claim(params.prId, "prune").pipe(
          Effect.andThen(reap({ ...params, force: params.force ?? false })),
          Effect.catchTag("WorkspaceBusyError", () =>
            Effect.succeed<PruneWorktreeOutcome>({ pruned: false, reason: "busy" }),
          ),
        ),
      );

    const sweep = () =>
      Effect.gen(function* () {
        const repos = yield* dbTry("ready clones read", () =>
          db.select().from(repositories).where(eq(repositories.cloneStatus, "ready")).all(),
        );
        let scanned = 0;
        let pruned = 0;
        let keptUnpushed = 0;

        for (const repo of repos) {
          if (!repo.clonePath) continue;
          const clonePath = repo.clonePath;
          // By branch, not by worktree: an agent branch whose worktree is
          // already gone still clutters the user's branch list.
          const prNumbers = (yield* Effect.promise(() => listRefs(clonePath, ["refs/heads/revv/"])))
            .map(agentBranchPr)
            .filter((n): n is number => n !== null);

          for (const prNumber of prNumbers) {
            scanned++;
            const prRow = yield* dbTry("PR status read", () =>
              db
                .select({ id: pullRequests.id, status: pullRequests.status })
                .from(pullRequests)
                .where(
                  and(
                    eq(pullRequests.repositoryId, repo.id),
                    eq(pullRequests.externalId, prNumber),
                  ),
                )
                .get(),
            );
            if (prRow && prRow.status === "open") continue;
            const outcome = yield* (
              prRow
                ? prune({ repoId: repo.id, prId: prRow.id, prNumber })
                : reap({ repoId: repo.id, prNumber, force: false })
            ).pipe(
              Effect.catchTag("CloneError", (err) =>
                Effect.sync((): PruneWorktreeOutcome => {
                  logError(
                    "pr-worktree",
                    `pruning ${repo.fullName}#${prNumber} failed:`,
                    err.message,
                  );
                  return { pruned: false, reason: "not-found" };
                }),
              ),
            );
            if (outcome.pruned) pruned++;
            else if (outcome.reason === "unpushed-commits") keptUnpushed++;
          }
        }

        if (pruned > 0 || keptUnpushed > 0) {
          debug(
            "pr-worktree",
            `worktree sweep: pruned ${pruned}, kept ${keptUnpushed} with unpushed commits (scanned ${scanned})`,
          );
        }
        return { scanned, pruned, keptUnpushed };
      });

    return { claim, locate, ensure, prune, sweep };
  }),
);
