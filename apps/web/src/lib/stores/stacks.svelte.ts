// ── Stacks ──────────────────────────────────────────────────────────────────
//
// The GitHub stack the open PR sits in, with Revv's per-layer state (tracked,
// reviewed, restacked). One entry per stack, keyed `repositoryId:number`, so
// moving between layers of the same stack reuses what's on screen. The
// server is the source of truth: this store re-reads it on `stack:updated`,
// on a member's walkthrough lifecycle, and when a brief changes state.

import {
  type PrStackDetail,
  type StackLayer,
  type StackMergeRun,
  type StackReviewScope,
  type StackReviewStarted,
  stackKey,
} from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { RequestState } from "./_types";
import { getPrById } from "./prs.svelte";

interface StackEntry {
  readonly request: RequestState<PrStackDetail>;
  /** A member PR the stack was last read through; re-reads go through it. */
  readonly viaPrId: string;
  readonly loadedAt: number;
}

/** A read this young is good enough for moving to another layer. */
const FRESH_FOR_MS = 15_000;
/** Coalesces a burst of member walkthrough events into one re-read. */
const REFRESH_DEBOUNCE_MS = 400;

let entries = $state(new Map<string, StackEntry>());
let mergeRuns = $state(new Map<string, StackMergeRun>());

const inflight = new Map<string, Promise<void>>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setEntry(key: string, entry: StackEntry): void {
  entries.set(key, entry);
  entries = new Map(entries);
}

/** The stack key a PR belongs to, from the poll's record of membership. */
function keyForPr(prId: string): string | null {
  const pr = getPrById(prId);
  return pr?.stack ? stackKey(pr.repositoryId, pr.stack.number) : null;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function fetchStack(key: string, prId: string): Promise<void> {
  const existing = entries.get(key);
  if (existing?.request.status !== "ok") {
    setEntry(key, { request: RequestState.loading(), viaPrId: prId, loadedAt: 0 });
  }
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack.get();
    if (error || !data || !("stack" in data)) {
      const message = error
        ? apiErrorMessage(error, "Couldn't load the stack")
        : "Unexpected response";
      const current = entries.get(key);
      // Keep showing what we have; only an empty map shows the error.
      if (current?.request.status !== "ok") {
        setEntry(key, { request: RequestState.error(message), viaPrId: prId, loadedAt: 0 });
      }
      return;
    }
    const stack = data.stack ? (plain(data.stack) as PrStackDetail) : null;
    if (!stack) {
      // GitHub says this PR left the stack (or never was in one).
      entries.delete(key);
      entries = new Map(entries);
      return;
    }
    setEntry(stackKey(stack.repositoryId, stack.number), {
      request: RequestState.ok(stack),
      viaPrId: prId,
      loadedAt: Date.now(),
    });
  } catch (e) {
    const current = entries.get(key);
    if (current?.request.status !== "ok") {
      setEntry(key, {
        request: RequestState.error(e instanceof Error ? e.message : String(e)),
        viaPrId: prId,
        loadedAt: 0,
      });
    }
  }
}

function load(key: string, prId: string): Promise<void> {
  const running = inflight.get(key);
  if (running) return running;
  const promise = fetchStack(key, prId).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Read the PR's stack unless a fresh copy is on hand. No-op for an unstacked PR. */
export function ensureStack(prId: string): Promise<void> {
  const key = keyForPr(prId);
  if (!key) return Promise.resolve();
  const entry = entries.get(key);
  if (entry?.request.status === "ok" && Date.now() - entry.loadedAt < FRESH_FOR_MS) {
    return Promise.resolve();
  }
  return load(key, prId);
}

/** Re-read a stack now, whatever its age. */
export function refreshStack(prId: string): Promise<void> {
  const key = keyForPr(prId);
  return key ? load(key, prId) : Promise.resolve();
}

/** The PR's stack request, or idle when it isn't stacked. */
export function getStackRequest(prId: string): RequestState<PrStackDetail> {
  const key = keyForPr(prId);
  return (key ? entries.get(key)?.request : undefined) ?? RequestState.idle();
}

/** The PR's loaded stack, or null. */
export function getStack(prId: string): PrStackDetail | null {
  const request = getStackRequest(prId);
  return request.status === "ok" ? request.data : null;
}

/** The layer the PR occupies in its loaded stack. */
export function getLayer(prId: string): StackLayer | null {
  return getStack(prId)?.layers.find((l) => l.prId === prId) ?? null;
}

/** The layer `offset` positions away (+1 is up, toward the top), or null at an end. */
export function getNeighbour(prId: string, offset: number): StackLayer | null {
  const stack = getStack(prId);
  const here = stack?.layers.find((l) => l.prId === prId);
  if (!stack || !here) return null;
  return stack.layers.find((l) => l.position === here.position + offset) ?? null;
}

export function getMergeRun(repositoryId: string, stackNumber: number): StackMergeRun | null {
  return mergeRuns.get(stackKey(repositoryId, stackNumber)) ?? null;
}

function scheduleRefresh(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  const pending = refreshTimers.get(key);
  if (pending) clearTimeout(pending);
  refreshTimers.set(
    key,
    setTimeout(() => {
      refreshTimers.delete(key);
      const current = entries.get(key);
      if (current) void load(key, current.viaPrId);
    }, REFRESH_DEBOUNCE_MS),
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

export function onStackUpdated(data: { repositoryId: string; stackNumber: number }): void {
  scheduleRefresh(stackKey(data.repositoryId, data.stackNumber));
}

export function onStackBriefStatusChanged(data: {
  repositoryId: string;
  stackNumber: number;
}): void {
  scheduleRefresh(stackKey(data.repositoryId, data.stackNumber));
}

export function onStackMergeProgress(run: StackMergeRun): void {
  mergeRuns.set(stackKey(run.repositoryId, run.stackNumber), run);
  mergeRuns = new Map(mergeRuns);
  scheduleRefresh(stackKey(run.repositoryId, run.stackNumber));
}

/** A member's walkthrough started, finished, or moved: its layer's review state changed. */
export function onMemberWalkthroughLifecycle(prId: string): void {
  const key = keyForPr(prId);
  if (key) scheduleRefresh(key);
}

/** Seed a merge run read over REST (the sheet opening mid-run). */
export function setMergeRun(run: StackMergeRun | null, key: string): void {
  if (run) mergeRuns.set(key, run);
  else mergeRuns.delete(key);
  mergeRuns = new Map(mergeRuns);
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * Queue walkthroughs for the stack's open layers, bottom-up. Progress comes
 * back through each layer's walkthrough events. Null when the ask failed.
 */
export async function startStackReview(
  prId: string,
  scope: StackReviewScope,
): Promise<StackReviewStarted | null> {
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack.review.post({ scope });
    if (error || !data || !("queued" in data)) return null;
    void refreshStack(prId);
    return data;
  } catch {
    return null;
  }
}

/** Start the stack brief for the stack's current version, unless it's written. */
export async function requestStackBrief(prId: string): Promise<string | null> {
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack.brief.post();
    if (error || !data || !("briefId" in data)) return null;
    void refreshStack(prId);
    return data.briefId;
  } catch {
    return null;
  }
}

/** Ask the server to warm the neighbouring layers' diffs. Best-effort. */
export function warmNeighbours(prId: string): void {
  void api.api
    .prs({ id: prId })
    .stack.warm.post()
    .catch(() => undefined);
}
