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
  type StackReviewScope,
  type StackReviewStarted,
  stackKey,
} from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { plain, thrownMessage } from "$lib/api/wire";
import { layerAt, layerOf } from "$lib/stacks/locate";
import { RequestState } from "./_types";
import { getPrById } from "./prs.svelte";
import { singleFlight } from "./single-flight";

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
    const actual = stackKey(stack.repositoryId, stack.number);
    setEntry(actual, { request: RequestState.ok(stack), viaPrId: prId, loadedAt: Date.now() });
    // The poll filed this PR under another stack. Its placeholder resolves to
    // nothing rather than loading forever; a read already shown there stays.
    if (actual !== key && entries.get(key)?.request.status !== "ok") {
      entries.delete(key);
      entries = new Map(entries);
    }
  } catch (e) {
    const current = entries.get(key);
    if (current?.request.status !== "ok") {
      setEntry(key, {
        request: RequestState.error(thrownMessage(e)),
        viaPrId: prId,
        loadedAt: 0,
      });
    }
  }
}

const reads = singleFlight(fetchStack);

/** Read the PR's stack unless a fresh copy is on hand. No-op for an unstacked PR. */
export function ensureStack(prId: string): Promise<void> {
  const key = keyForPr(prId);
  if (!key) return Promise.resolve();
  const entry = entries.get(key);
  if (entry?.request.status === "ok" && Date.now() - entry.loadedAt < FRESH_FOR_MS) {
    return Promise.resolve();
  }
  return reads.run(key, prId);
}

/**
 * Re-read a stack now, whatever its age. A read already in flight may predate
 * the change that asked for this one, so it reads again after that one ends.
 */
export function refreshStack(prId: string): Promise<void> {
  const key = keyForPr(prId);
  return key ? reads.rerun(key, prId) : Promise.resolve();
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
  const stack = getStack(prId);
  return stack ? layerOf(stack, prId, getPrById(prId)?.externalId ?? null) : null;
}

/** The layer `offset` positions away (+1 is up, toward the top), or null at an end. */
export function getNeighbour(prId: string, offset: number): StackLayer | null {
  const stack = getStack(prId);
  const here = getLayer(prId);
  return stack && here ? layerAt(stack, here, offset) : null;
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
      if (current) void reads.rerun(key, current.viaPrId);
    }, REFRESH_DEBOUNCE_MS),
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

/** The stack moved on GitHub, or something Revv shows on it did: re-read it shortly. */
export function onStackUpdated(data: { repositoryId: string; stackNumber: number }): void {
  scheduleRefresh(stackKey(data.repositoryId, data.stackNumber));
}

/** The brief rides on the stack detail, so a brief's lifecycle is a stack update. */
export function onStackBriefStatusChanged(data: {
  repositoryId: string;
  stackNumber: number;
}): void {
  onStackUpdated(data);
}

/** A member's walkthrough started, finished, or moved: its layer's review state changed. */
export function onMemberWalkthroughLifecycle(prId: string): void {
  const key = keyForPr(prId);
  if (key) scheduleRefresh(key);
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
