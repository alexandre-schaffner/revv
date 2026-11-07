// Git half of "does this PR conflict with its base, and bring it up to date".
//
// The check never touches a worktree: `git merge-tree` merges the two fetched
// tips in the object store. The sync runs in a scratch worktree detached at
// the PR's remote head, never in the PR's chat worktree — the chat agent's
// unpushed commits and uncommitted edits stay exactly where they are — and
// never names a local branch, since the clone shares refs with the user's own
// checkouts. Its only durable effect is the leased push at the end.

import type { BaseConflictStrategy } from "@revv/shared";
import {
  changedPaths,
  commitParents,
  deleteRef,
  hasConflictMarkers,
  isAncestor,
  isMergeInProgress,
  isRebaseInProgress,
  merge,
  mergeBase,
  mergeTreeWriteTree,
  rebaseOnto,
  resolveRef,
  revListCount,
  unmergedPaths,
  workingTreeIsClean,
} from "../git/ops";
import { scratchRef } from "../git/pr-refs";
import { type PushOutcome, pushLeased, pushOutcome } from "../git/push";
import {
  type Failed,
  fetchForScratch,
  firstLine,
  SCRATCH_OPERATION_TIMEOUT_MS,
} from "../git/scratch";
import { parseMergeTree } from "./merge-tree";

export interface SyncRepo {
  readonly clonePath: string;
  readonly remoteUrl: string;
  readonly prNumber: number;
  readonly baseBranch: string;
  /** The check's and the sync's tips live apart: a check may run while a sync does. */
  readonly refs: "base-conflicts" | "base-sync";
}

export interface Tips {
  readonly baseTip: string;
  readonly headTip: string;
  readonly mergeBase: string;
}

const refsFor = (repo: SyncRepo) => ({
  base: scratchRef(repo.refs, repo.prNumber, "base"),
  head: scratchRef(repo.refs, repo.prNumber, "head"),
});

/**
 * Fetch the base branch and the PR head (`headSource`, a remote ref: the
 * source branch when Revv will push to it, `refs/pull/N/head` otherwise) and
 * find where they forked. The clone is shallow, so a missing merge base earns
 * one deeper fetch before giving up.
 */
export async function fetchTips(
  repo: SyncRepo,
  headSource: string,
): Promise<({ readonly kind: "ok" } & Tips) | Failed> {
  const refs = refsFor(repo);
  const refspecs = [`+refs/heads/${repo.baseBranch}:${refs.base}`, `+${headSource}:${refs.head}`];
  const fetch = (deepen: boolean) =>
    fetchForScratch(repo.clonePath, repo.remoteUrl, refspecs, deepen);

  const fetchError = await fetch(false);
  if (fetchError) return { kind: "failed", message: `Couldn't fetch: ${fetchError}` };
  const baseTip = await resolveRef(repo.clonePath, refs.base);
  const headTip = await resolveRef(repo.clonePath, refs.head);
  if (!baseTip || !headTip) return { kind: "failed", message: "Couldn't read the fetched tips" };

  let forkPoint = await mergeBase(repo.clonePath, baseTip, headTip);
  if (!forkPoint) {
    const deeperError = await fetch(true);
    if (deeperError) return { kind: "failed", message: `Couldn't fetch history: ${deeperError}` };
    forkPoint = await mergeBase(repo.clonePath, baseTip, headTip);
  }
  if (!forkPoint) {
    return {
      kind: "failed",
      message: `Couldn't find where this branch forked from ${repo.baseBranch}`,
    };
  }
  return { kind: "ok", baseTip, headTip, mergeBase: forkPoint };
}

export async function deleteTipRefs(repo: SyncRepo): Promise<void> {
  const refs = refsFor(repo);
  await deleteRef(repo.clonePath, refs.base);
  await deleteRef(repo.clonePath, refs.head);
}

export interface TipsCheck {
  readonly status: "clean" | "conflicts";
  readonly files: readonly string[];
  readonly behindBy: number | null;
  readonly touchesWorkflows: boolean;
}

export async function checkTips(clonePath: string, tips: Tips): Promise<TipsCheck | Failed> {
  const run = await mergeTreeWriteTree(clonePath, tips.baseTip, tips.headTip);
  if (run.timedOut) return { kind: "failed", message: "git merge-tree took too long" };
  const merged = parseMergeTree(run.exitCode, run.stdout, run.stderr);
  if (merged.kind === "failed") return merged;
  const behindBy = await revListCount(clonePath, `${tips.headTip}..${tips.baseTip}`);
  const workflows = await changedPaths(
    clonePath,
    tips.mergeBase,
    tips.baseTip,
    ".github/workflows",
  );
  return {
    status: merged.kind,
    files: merged.kind === "conflicts" ? merged.files : [],
    behindBy,
    touchesWorkflows: workflows.length > 0,
  };
}

export interface OperationInput {
  readonly strategy: BaseConflictStrategy;
  readonly scratchPath: string;
  readonly tips: Tips;
  readonly baseBranch: string;
  readonly sourceBranch: string;
}

/** A conflict leaves the merge or rebase paused in the scratch worktree for the agent. */
export async function startOperation(
  input: OperationInput,
): Promise<
  { readonly kind: "clean" } | { readonly kind: "conflict"; readonly files: string[] } | Failed
> {
  const { scratchPath, tips } = input;
  const run =
    input.strategy === "merge"
      ? await merge(scratchPath, tips.baseTip, {
          message: `Merge branch '${input.baseBranch}' into ${input.sourceBranch}`,
          noFastForward: true,
          timeoutMs: SCRATCH_OPERATION_TIMEOUT_MS,
        })
      : await rebaseOnto(
          scratchPath,
          tips.baseTip,
          tips.mergeBase,
          tips.headTip,
          SCRATCH_OPERATION_TIMEOUT_MS,
        );
  if (run.ok) return { kind: "clean" };
  const files = await unmergedPaths(scratchPath).catch(() => []);
  if (files.length > 0) return { kind: "conflict", files };
  return {
    kind: "failed",
    message: run.timedOut
      ? `The ${input.strategy} took too long`
      : `git ${input.strategy} failed: ${firstLine(run.stderr)}`,
  };
}

/**
 * Whether the scratch worktree holds a finished, honest result: nothing still
 * in progress, nothing left uncommitted, no conflict markers committed, and
 * the shape the strategy promises — a merge commit of exactly the PR head and
 * the base tip, or the PR's commits replayed on top of the base tip.
 */
export async function verifyResolution(
  input: OperationInput & { readonly conflictFiles: readonly string[] },
): Promise<{ readonly kind: "ok"; readonly head: string } | Failed> {
  const { scratchPath, tips } = input;
  if (await isMergeInProgress(scratchPath)) {
    return { kind: "failed", message: "The merge is still in conflict" };
  }
  if (await isRebaseInProgress(scratchPath)) {
    return { kind: "failed", message: "The rebase is still in progress" };
  }
  const clean = await workingTreeIsClean(scratchPath);
  if (!clean.clean) {
    return { kind: "failed", message: "The agent left changes uncommitted" };
  }
  const head = await resolveRef(scratchPath, "HEAD");
  if (!head) return { kind: "failed", message: "Couldn't read the result" };
  if (await hasConflictMarkers(scratchPath, head, input.conflictFiles)) {
    return { kind: "failed", message: "Conflict markers are still in the resolved files" };
  }

  if (input.strategy === "merge") {
    const parents = await commitParents(scratchPath, head);
    if (parents.length !== 2 || parents[0] !== tips.headTip || parents[1] !== tips.baseTip) {
      return {
        kind: "failed",
        message: `The result isn't a merge of ${input.baseBranch} into the PR branch`,
      };
    }
    return { kind: "ok", head };
  }

  const own = await revListCount(scratchPath, `${tips.mergeBase}..${tips.headTip}`);
  const replayed = await revListCount(scratchPath, `${tips.baseTip}..${head}`);
  if (!(await isAncestor(scratchPath, tips.baseTip, head)) || head === tips.baseTip) {
    return {
      kind: "failed",
      message: `The result isn't the PR's commits on top of ${input.baseBranch}`,
    };
  }
  if ((own ?? 0) > 0 && (replayed ?? 0) === 0) {
    return { kind: "failed", message: "The rebase dropped every commit on the branch" };
  }
  return { kind: "ok", head };
}

/** Push `head` to the PR's source branch, leased on the head Revv started from. */
export async function pushResult(
  scratchPath: string,
  remoteUrl: string,
  sourceBranch: string,
  from: string,
  head: string,
): Promise<PushOutcome> {
  return pushOutcome(
    await pushLeased(scratchPath, remoteUrl, [{ branch: sourceBranch, from, to: head }]),
  );
}
