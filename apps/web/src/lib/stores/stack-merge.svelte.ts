import { type MergeMethod, type StackMergePlan, type StackMergeRun, stackKey } from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { plain, thrownMessage } from "$lib/api/wire";
import { RequestState } from "./_types";
import { onStackUpdated, refreshStack } from "./stacks.svelte";

let openFor = $state<string | null>(null);
let plan = $state<RequestState<StackMergePlan>>(RequestState.idle());
let runs = $state(new Map<string, StackMergeRun>());

export function openStackMergeSheet(prId: string): void {
  openFor = prId;
}

export function closeStackMergeSheet(): void {
  openFor = null;
  plan = RequestState.idle();
}

export function getStackMergeSheetPrId(): string | null {
  return openFor;
}

export function getStackMergePlan(): RequestState<StackMergePlan> {
  return plan;
}

export function getMergeRun(repositoryId: string, stackNumber: number): StackMergeRun | null {
  return runs.get(stackKey(repositoryId, stackNumber)) ?? null;
}

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
}

export async function loadStackMergePlan(prId: string, quiet = false): Promise<void> {
  if (!quiet || plan.status !== "ok") plan = RequestState.loading();
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
    if (next.latestRun) setRun(next.latestRun);
    plan = RequestState.ok(next);
  } catch (e) {
    if (openFor === prId) plan = RequestState.error(thrownMessage(e));
  }
}

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

export function onStackMergeProgress(run: StackMergeRun): void {
  setRun(run);
  onStackUpdated(run);
}
