// Nothing here names a local branch: the clone shares refs with the PR
// worktrees (and, for linked repos, with the user's own checkouts), so the
// rebase works on SHAs and the push maps them straight onto the remote
// branches. Commits are written with the user's own identity, but neither
// their hooks nor their signing setup run: nobody is there to answer them.

import { existsSync, rmSync } from "node:fs";
import {
  abortDetachedRebase,
  addDetachedWorktree,
  classifyPushFailure,
  commitExists,
  deleteRef,
  fetchForRebase,
  isAncestor,
  mergeBase,
  pushAtomicWithLeases,
  rebaseDetached,
  removeWorktree,
  resolveRef,
  unmergedPaths,
  workflowPermissionRejection,
} from "../GitOps";
import type { RebaseStep } from "./rebase-plan";

const REBASE_TIMEOUT_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 3 * 60_000;
const DEEPEN_BY = 1_000;

export interface ReplayInput {
  readonly clonePath: string;
  readonly scratchPath: string;
  readonly remoteUrl: string;
  readonly baseRefName: string;
  readonly stackNumber: number;
  readonly steps: readonly RebaseStep[];
}

export type ReplayOutcome =
  | {
      readonly kind: "replayed";
      readonly heads: ReadonlyMap<number, string>;
    }
  | {
      readonly kind: "conflict";
      readonly number: number;
      readonly ontoLabel: string;
      readonly files: readonly string[];
    }
  | { readonly kind: "failed"; readonly message: string };

export type PushOutcome =
  | { readonly kind: "pushed" }
  | { readonly kind: "moved" | "auth" | "rejected"; readonly message: string };

const firstLine = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("hint:")) ?? "git failed";

const baseRef = (stackNumber: number) => `refs/revv/stack-rebase/${stackNumber}/base`;

async function clearScratch(input: ReplayInput): Promise<void> {
  if (existsSync(input.scratchPath)) await abortDetachedRebase(input.scratchPath);
  await removeWorktree(input.clonePath, input.scratchPath);
  if (existsSync(input.scratchPath)) {
    rmSync(input.scratchPath, { recursive: true, force: true });
    await removeWorktree(input.clonePath, input.scratchPath);
  }
}

export async function cleanupReplay(input: ReplayInput): Promise<void> {
  await clearScratch(input);
  await deleteRef(input.clonePath, baseRef(input.stackNumber));
}

async function fetchStack(input: ReplayInput, deepen: boolean): Promise<string | null> {
  const r = await fetchForRebase(
    input.clonePath,
    input.remoteUrl,
    [
      `+refs/heads/${input.baseRefName}:${baseRef(input.stackNumber)}`,
      ...input.steps.map((s) => s.tip),
    ],
    deepen ? { deepen: DEEPEN_BY, timeoutMs: FETCH_TIMEOUT_MS } : { timeoutMs: FETCH_TIMEOUT_MS },
  );
  return r.ok ? null : firstLine(r.stderr);
}

async function upstreamOf(
  cwd: string,
  step: RebaseStep,
  ontoBefore: string,
): Promise<string | null> {
  for (const candidate of step.upstreams) {
    if ((await commitExists(cwd, candidate)) && (await isAncestor(cwd, candidate, step.tip))) {
      return candidate;
    }
  }
  return mergeBase(cwd, ontoBefore, step.tip);
}

export async function replayStack(input: ReplayInput): Promise<ReplayOutcome> {
  const { clonePath, scratchPath } = input;
  const fetchError = await fetchStack(input, false);
  if (fetchError) return { kind: "failed", message: `Couldn't fetch the stack: ${fetchError}` };
  const baseTip = await resolveRef(clonePath, baseRef(input.stackNumber));
  if (!baseTip) return { kind: "failed", message: `Couldn't read ${input.baseRefName}'s tip` };

  await clearScratch(input);
  const added = await addDetachedWorktree(clonePath, scratchPath, baseTip, REBASE_TIMEOUT_MS);
  if (!added.ok) {
    return { kind: "failed", message: `Couldn't prepare a worktree: ${firstLine(added.stderr)}` };
  }

  const heads = new Map<number, string>();
  const tipOf = (number: number) => input.steps.find((s) => s.number === number)?.tip ?? null;
  let deepened = false;

  for (const step of input.steps) {
    const onto = step.onto.kind === "base" ? baseTip : heads.get(step.onto.number);
    const ontoBefore = step.onto.kind === "base" ? baseTip : tipOf(step.onto.number);
    const ontoLabel = step.onto.kind === "base" ? input.baseRefName : `#${step.onto.number}`;
    if (!onto || !ontoBefore) {
      return { kind: "failed", message: `Lost track of #${step.number}'s base` };
    }

    let upstream = await upstreamOf(scratchPath, step, ontoBefore);
    if (!upstream && !deepened) {
      deepened = true;
      const deepenError = await fetchStack(input, true);
      if (deepenError) return { kind: "failed", message: `Couldn't fetch history: ${deepenError}` };
      upstream = await upstreamOf(scratchPath, step, ontoBefore);
    }
    if (!upstream) {
      return {
        kind: "failed",
        message: `Couldn't work out where #${step.number}'s own commits start — rebase it locally`,
      };
    }
    if (upstream === onto) {
      heads.set(step.number, step.tip);
      continue;
    }

    const rebased = await rebaseDetached(scratchPath, onto, upstream, step.tip, REBASE_TIMEOUT_MS);
    if (!rebased.ok) {
      const files = await unmergedPaths(scratchPath).catch(() => []);
      await abortDetachedRebase(scratchPath);
      if (files.length > 0) return { kind: "conflict", number: step.number, ontoLabel, files };
      return {
        kind: "failed",
        message: rebased.timedOut
          ? `Rebasing #${step.number} took too long`
          : `Couldn't rebase #${step.number}: ${firstLine(rebased.stderr)}`,
      };
    }
    const head = await resolveRef(scratchPath, "HEAD");
    if (!head) return { kind: "failed", message: `Lost #${step.number}'s rebased head` };
    heads.set(step.number, head);
  }

  return { kind: "replayed", heads };
}

export async function pushStack(
  clonePath: string,
  remoteUrl: string,
  moved: ReadonlyArray<{ readonly headRef: string; readonly from: string; readonly to: string }>,
): Promise<PushOutcome> {
  if (moved.length === 0) return { kind: "pushed" };
  const r = await pushAtomicWithLeases(
    clonePath,
    remoteUrl,
    moved.map((m) => ({ branch: m.headRef, from: m.from, to: m.to })),
    FETCH_TIMEOUT_MS,
  );
  if (r.ok) return { kind: "pushed" };

  const workflow = workflowPermissionRejection(r.stderr);
  if (workflow) {
    return {
      kind: "rejected",
      message:
        `GitHub won't let Revv's credential push ${workflow.path ?? "files under .github/workflows/"} ` +
        "— rebase this stack from your own checkout (gh stack rebase)",
    };
  }
  switch (classifyPushFailure(r.stderr)) {
    case "remote-moved":
      return {
        kind: "moved",
        message: "A layer got new commits while Revv was rebasing — nothing was pushed, try again",
      };
    case "auth":
      return { kind: "auth", message: "GitHub refused Revv's credential for this push" };
    case "rejected":
      return { kind: "rejected", message: `GitHub rejected the push: ${firstLine(r.stderr)}` };
  }
}
