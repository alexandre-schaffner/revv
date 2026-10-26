// Git half of "does this PR conflict with its base, and bring it up to date".
//
// The check never touches a worktree: `git merge-tree` merges the two fetched
// tips in the object store. The sync runs in a scratch worktree detached at
// the PR's remote head, never in the PR's chat worktree — the chat agent's
// unpushed commits and uncommitted edits stay exactly where they are — and
// never names a local branch, since the clone shares refs with the user's own
// checkouts. Its only durable effect is the leased push at the end.

import { existsSync, rmSync } from "node:fs";
import type { BaseConflictStrategy } from "@revv/shared";
import {
  abortDetachedMerge,
  abortDetachedRebase,
  addDetachedWorktree,
  changedPaths,
  classifyPushFailure,
  commitParents,
  deleteRef,
  describePushRejection,
  fetchForRebase,
  hasConflictMarkers,
  isAncestor,
  isMergeInProgress,
  isRebaseInProgress,
  mergeBase,
  mergeTreeWriteTree,
  mergeUnattended,
  pushAtomicWithLeases,
  rebaseDetached,
  removeWorktree,
  resolveRef,
  revListCount,
  unmergedPaths,
  workingTreeIsClean,
} from "../GitOps";
import { parseMergeTree } from "./merge-tree";

const FETCH_TIMEOUT_MS = 3 * 60_000;
const OPERATION_TIMEOUT_MS = 5 * 60_000;
const DEEPEN_BY = 1_000;

export interface SyncRepo {
  readonly clonePath: string;
  readonly remoteUrl: string;
  readonly prNumber: number;
  readonly baseBranch: string;
}

export interface Tips {
  readonly baseTip: string;
  readonly headTip: string;
  readonly mergeBase: string;
}

export type Failed = { readonly kind: "failed"; readonly message: string };

const firstLine = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("hint:")) ?? "git failed";

const refsFor = (prNumber: number) => ({
  base: `refs/revv/base-conflicts/${prNumber}/base`,
  head: `refs/revv/base-conflicts/${prNumber}/head`,
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
  const refs = refsFor(repo.prNumber);
  const refspecs = [`+refs/heads/${repo.baseBranch}:${refs.base}`, `+${headSource}:${refs.head}`];
  const fetch = (deepen: boolean) =>
    fetchForRebase(
      repo.clonePath,
      repo.remoteUrl,
      refspecs,
      deepen ? { deepen: DEEPEN_BY, timeoutMs: FETCH_TIMEOUT_MS } : { timeoutMs: FETCH_TIMEOUT_MS },
    );

  const first = await fetch(false);
  if (!first.ok) return { kind: "failed", message: `Couldn't fetch: ${firstLine(first.stderr)}` };
  const baseTip = await resolveRef(repo.clonePath, refs.base);
  const headTip = await resolveRef(repo.clonePath, refs.head);
  if (!baseTip || !headTip) return { kind: "failed", message: "Couldn't read the fetched tips" };

  let forkPoint = await mergeBase(repo.clonePath, baseTip, headTip);
  if (!forkPoint) {
    const deeper = await fetch(true);
    if (!deeper.ok) {
      return { kind: "failed", message: `Couldn't fetch history: ${firstLine(deeper.stderr)}` };
    }
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
  const refs = refsFor(repo.prNumber);
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

export async function clearScratch(clonePath: string, scratchPath: string): Promise<void> {
  if (existsSync(scratchPath)) {
    if (await isMergeInProgress(scratchPath)) await abortDetachedMerge(scratchPath);
    if (await isRebaseInProgress(scratchPath)) await abortDetachedRebase(scratchPath);
  }
  await removeWorktree(clonePath, scratchPath);
  if (existsSync(scratchPath)) {
    rmSync(scratchPath, { recursive: true, force: true });
    await removeWorktree(clonePath, scratchPath);
  }
}

/** A fresh scratch worktree detached at `sha`, clearing whatever a dead run left. */
export async function prepareScratch(
  clonePath: string,
  scratchPath: string,
  sha: string,
): Promise<{ readonly kind: "ok" } | Failed> {
  await clearScratch(clonePath, scratchPath);
  const added = await addDetachedWorktree(clonePath, scratchPath, sha, OPERATION_TIMEOUT_MS);
  return added.ok
    ? { kind: "ok" }
    : { kind: "failed", message: `Couldn't prepare a worktree: ${firstLine(added.stderr)}` };
}

export interface OperationInput {
  readonly strategy: BaseConflictStrategy;
  readonly scratchPath: string;
  readonly tips: Tips;
  readonly baseBranch: string;
  readonly sourceBranch: string;
}

/**
 * Start merging the base into the PR head, or replaying the PR onto the base.
 * A conflict leaves the operation paused in the scratch worktree for the agent.
 */
export async function startOperation(
  input: OperationInput,
): Promise<
  { readonly kind: "clean" } | { readonly kind: "conflict"; readonly files: string[] } | Failed
> {
  const { scratchPath, tips } = input;
  const run =
    input.strategy === "merge"
      ? await mergeUnattended(
          scratchPath,
          tips.baseTip,
          `Merge branch '${input.baseBranch}' into ${input.sourceBranch}`,
          OPERATION_TIMEOUT_MS,
        )
      : await rebaseDetached(
          scratchPath,
          tips.baseTip,
          tips.mergeBase,
          tips.headTip,
          OPERATION_TIMEOUT_MS,
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
  const clean = await workingTreeIsClean(scratchPath).catch(() => ({ clean: false, output: "" }));
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

export type PushResult =
  | { readonly kind: "pushed" }
  | { readonly kind: "moved" }
  | { readonly kind: "auth" | "rejected"; readonly message: string };

/** Push `head` to the PR's source branch, leased on the head Revv started from. */
export async function pushResult(
  scratchPath: string,
  remoteUrl: string,
  sourceBranch: string,
  from: string,
  head: string,
): Promise<PushResult> {
  const r = await pushAtomicWithLeases(
    scratchPath,
    remoteUrl,
    [{ branch: sourceBranch, from, to: head }],
    FETCH_TIMEOUT_MS,
  );
  if (r.ok) return { kind: "pushed" };
  switch (classifyPushFailure(r.stderr)) {
    case "remote-moved":
      return { kind: "moved" };
    case "auth":
      return { kind: "auth", message: "GitHub refused Revv's credential for this push" };
    case "rejected":
      return { kind: "rejected", message: describePushRejection(r.stderr) };
  }
}
