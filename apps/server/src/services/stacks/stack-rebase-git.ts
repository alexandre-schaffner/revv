// Nothing here names a local branch: the clone shares refs with the PR
// worktrees (and, for linked repos, with the user's own checkouts), so the
// rebase works on SHAs and the push maps them straight onto the remote
// branches. Commits are written with the user's own identity and signed the
// way they sign; their hooks don't run.

import {
  abortRebase,
  commitExists,
  deleteRef,
  isAncestor,
  mergeBase,
  rebaseOnto,
  resolveRef,
  unmergedPaths,
} from "../git/ops";
import { scratchRef } from "../git/pr-refs";
import { type PushOutcome, pushLeased, pushOutcome } from "../git/push";
import {
  clearScratch,
  fetchForScratch,
  firstLine,
  prepareScratch,
  SCRATCH_OPERATION_TIMEOUT_MS,
} from "../git/scratch";
import type { RebaseStep } from "./rebase-plan";

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

const baseRef = (stackNumber: number) => scratchRef("stack-rebase", stackNumber, "base");

export async function cleanupReplay(input: ReplayInput): Promise<void> {
  await clearScratch(input.clonePath, input.scratchPath);
  await deleteRef(input.clonePath, baseRef(input.stackNumber));
}

function fetchStack(input: ReplayInput, deepen: boolean): Promise<string | null> {
  return fetchForScratch(
    input.clonePath,
    input.remoteUrl,
    [
      `+refs/heads/${input.baseRefName}:${baseRef(input.stackNumber)}`,
      ...input.steps.map((s) => s.tip),
    ],
    deepen,
  );
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

  const prepared = await prepareScratch(clonePath, scratchPath, baseTip);
  if (prepared.kind === "failed") return prepared;

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

    const rebased = await rebaseOnto(
      scratchPath,
      onto,
      upstream,
      step.tip,
      SCRATCH_OPERATION_TIMEOUT_MS,
    );
    if (!rebased.ok) {
      const files = await unmergedPaths(scratchPath).catch(() => []);
      await abortRebase(scratchPath);
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
  return pushOutcome(
    await pushLeased(
      clonePath,
      remoteUrl,
      moved.map((m) => ({ branch: m.headRef, from: m.from, to: m.to })),
    ),
  );
}
