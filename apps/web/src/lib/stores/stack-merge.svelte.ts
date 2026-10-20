// ── Stack merge sheet ───────────────────────────────────────────────────────
//
// Which PR's "Merge stack" sheet is open, the plan it shows, and the calls
// that start, cancel and continue a run. The sheet itself
// (`components/stack/StackMergeSheet.svelte`) renders it; anything that
// offers the action (the merge pill, the stack sheet, the palette) only opens
// it. The run's live state is `getMergeRun` in `stacks.svelte.ts`, fed by
// `stack-merge:progress`; the answers here seed it.

import { type MergeMethod, type StackMergePlan, type StackMergeRun, stackKey } from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { RequestState } from "./_types";
import { refreshStack, setMergeRun } from "./stacks.svelte";

let openFor = $state<string | null>(null);
let plan = $state<RequestState<StackMergePlan>>(RequestState.idle());

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

/** Eden revives ISO strings into `Date`s; SSE delivers strings. Keep one shape. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** What a run call answered: the run, or the server's reason in its own words. */
type StackMergeAnswer =
  | { readonly ok: true; readonly run: StackMergeRun }
  | { readonly ok: false; readonly error: string };

function seed(run: StackMergeRun): StackMergeRun {
  const clean = plain(run);
  setMergeRun(clean, stackKey(clean.repositoryId, clean.stackNumber));
  return clean;
}

/** Read the plan fresh from GitHub. A quiet reload keeps the current plan on screen. */
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
    if (next.activeRun) seed(next.activeRun);
    plan = RequestState.ok(next);
  } catch (e) {
    if (openFor === prId) plan = RequestState.error(e instanceof Error ? e.message : String(e));
  }
}

function answer(
  data: StackMergeRun | { error: string } | null | undefined,
  error: { status: number; value?: unknown } | null,
  fallback: string,
): StackMergeAnswer {
  if (error) return { ok: false, error: apiErrorMessage(error, fallback) };
  if (!data || !("status" in data)) return { ok: false, error: fallback };
  return { ok: true, run: seed(data) };
}

export async function startStackMerge(
  prId: string,
  body: {
    throughPosition: number;
    method: MergeMethod;
    expectedHeads: Record<string, string>;
  },
): Promise<StackMergeAnswer> {
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack.merge.post(body);
    const result = answer(data, error, "Couldn't start the merge");
    void refreshStack(prId);
    return result;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function cancelStackMerge(runId: string): Promise<StackMergeAnswer> {
  try {
    const { data, error } = await api.api["stack-merges"]({ id: runId }).cancel.post();
    return answer(data, error, "Couldn't cancel the merge");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function continueStackMerge(runId: string): Promise<StackMergeAnswer> {
  try {
    const { data, error } = await api.api["stack-merges"]({ id: runId }).continue.post();
    return answer(data, error, "Couldn't continue the merge");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
