// ── Stack merge sheet ───────────────────────────────────────────────────────
//
// Which PR's "Merge stack" sheet is open, the plan it shows, each stack's
// merge run, and the calls that start, cancel and continue one. The sheet
// itself (`components/stack/StackMergeSheet.svelte`) renders it; anything
// that offers the action (the merge pill, the stack sheet, the palette) only
// opens it. A run's live state comes from `stack-merge:progress`; the plan
// read and the run calls' answers reconcile it, the newest copy winning.

import { type MergeMethod, type StackMergePlan, type StackMergeRun, stackKey } from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { plain, thrownMessage } from "$lib/api/wire";
import { RequestState } from "./_types";
import { onStackUpdated, refreshStack } from "./stacks.svelte";

let openFor = $state<string | null>(null);
let plan = $state<RequestState<StackMergePlan>>(RequestState.idle());
let runs = $state(new Map<string, StackMergeRun>());
/** When each stack's run was last written here: a plan read that started earlier can't clear it. */
const runWrittenAt = new Map<string, number>();

export function openStackMergeSheet(prId: string): void {
  openFor = prId;
}

export function closeStackMergeSheet(): void {
  openFor = null;
  plan = RequestState.idle();
}

/** The PR whose merge sheet is open, or null. */
export function getStackMergeSheetPrId(): string | null {
  return openFor;
}

export function getStackMergePlan(): RequestState<StackMergePlan> {
  return plan;
}

/** The stack's latest merge run this client knows of, or null. */
export function getMergeRun(repositoryId: string, stackNumber: number): StackMergeRun | null {
  return runs.get(stackKey(repositoryId, stackNumber)) ?? null;
}

/** Whether `a` is the same run as `b` or a later one, at least as far along. */
function isNewer(a: StackMergeRun, b: StackMergeRun): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.updatedAt >= b.updatedAt;
}

function setRun(run: StackMergeRun): void {
  const key = stackKey(run.repositoryId, run.stackNumber);
  const current = runs.get(key);
  if (current && !isNewer(run, current)) return;
  runs.set(key, run);
  runs = new Map(runs);
  runWrittenAt.set(key, Date.now());
}

/**
 * Settle the stack's run against a plan read that started at `readAt`. The
 * plan names the run that's live or stopped; with none, a live or stopped run
 * still cached ended out of earshot (a missed SSE) and is dropped. A finished
 * run stays, so the sheet can still say how it ended.
 */
function reconcileRun(next: StackMergePlan, readAt: number): void {
  if (next.activeRun) {
    setRun(next.activeRun);
    return;
  }
  const key = stackKey(next.repositoryId, next.stackNumber);
  const current = runs.get(key);
  if (!current || current.status === "complete" || current.status === "cancelled") return;
  if ((runWrittenAt.get(key) ?? 0) > readAt) return;
  runs.delete(key);
  runs = new Map(runs);
  runWrittenAt.delete(key);
}

/** Read the plan fresh from GitHub. A quiet reload keeps the current plan on screen. */
export async function loadStackMergePlan(prId: string, quiet = false): Promise<void> {
  if (!quiet || plan.status !== "ok") plan = RequestState.loading();
  const readAt = Date.now();
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack["merge-plan"].get();
    if (openFor !== prId) return;
    if (error || !data || !("layers" in data)) {
      plan = RequestState.error(
        error
          ? apiErrorMessage(error, "Couldn't read the stack from GitHub")
          : "Unexpected response",
      );
      return;
    }
    const next = plain(data);
    reconcileRun(next, readAt);
    plan = RequestState.ok(next);
  } catch (e) {
    if (openFor === prId) plan = RequestState.error(thrownMessage(e));
  }
}

/** What a run call answered: the run, or the server's reason in its own words. */
export type StackMergeAnswer =
  | { readonly ok: true; readonly run: StackMergeRun }
  | { readonly ok: false; readonly error: string };

async function runCall(
  call: () => Promise<{
    data: StackMergeRun | { error: string } | null | undefined;
    error: { status: number; value?: unknown } | null;
  }>,
  fallback: string,
): Promise<StackMergeAnswer> {
  try {
    const { data, error } = await call();
    if (error) return { ok: false, error: apiErrorMessage(error, fallback) };
    if (!data || !("status" in data)) return { ok: false, error: fallback };
    const run = plain(data);
    setRun(run);
    return { ok: true, run };
  } catch (e) {
    return { ok: false, error: thrownMessage(e) };
  }
}

export async function startStackMerge(
  prId: string,
  body: {
    throughPosition: number;
    method: MergeMethod;
    expectedHeads: Record<string, string>;
  },
): Promise<StackMergeAnswer> {
  const result = await runCall(
    () => api.api.prs({ id: prId }).stack.merge.post(body),
    "Couldn't start the merge",
  );
  void refreshStack(prId);
  return result;
}

export function cancelStackMerge(runId: string): Promise<StackMergeAnswer> {
  return runCall(
    () => api.api["stack-merges"]({ id: runId }).cancel.post(),
    "Couldn't cancel the merge",
  );
}

export function continueStackMerge(runId: string): Promise<StackMergeAnswer> {
  return runCall(
    () => api.api["stack-merges"]({ id: runId }).continue.post(),
    "Couldn't continue the merge",
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

/** A run took a step; the stack it's merging moved with it. */
export function onStackMergeProgress(run: StackMergeRun): void {
  setRun(run);
  onStackUpdated(run);
}
