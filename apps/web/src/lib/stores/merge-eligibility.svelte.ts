// ── Merge eligibility ───────────────────────────────────────────────────────
//
// Whether the viewer can merge a PR, and what GitHub says about it right now
// (mergeable state, allowed methods), for the review bar's merge pill. One
// entry per PR. GitHub computes mergeability lazily and often answers
// `UNKNOWN` first, so the store re-asks on its own while the answer settles.

import type { MergeEligibility } from "@revv/shared";
import { isMergeStateSettling } from "$lib/utils/merge-blocker";
import { RequestState } from "./_types";
import { getMergeEligibility } from "./prs.svelte";

interface Entry {
  readonly request: RequestState<MergeEligibility>;
  /** What the answer was asked for; a different key asks again. */
  readonly askedFor: string;
  readonly askedAt: number;
}

/** Re-asks while GitHub is still computing mergeability, then gives up. */
const RETRY_MS = 3_000;
const MAX_RETRIES = 4;
/** An answer this young is reused when the same question comes back. */
const FRESH_FOR_MS = 15_000;

let entries = $state(new Map<string, Entry>());

/** The latest ask per PR; an answer to any earlier one is dropped. */
const generations = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setEntry(prId: string, entry: Entry): void {
  entries.set(prId, entry);
  entries = new Map(entries);
}

function updateEntry(prId: string, update: (entry: Entry) => Entry): void {
  const entry = entries.get(prId);
  if (entry) setEntry(prId, update(entry));
}

export function getMergeEligibilityRequest(prId: string): RequestState<MergeEligibility> {
  return entries.get(prId)?.request ?? RequestState.idle();
}

/**
 * Ask GitHub whether `prId` can merge. `askedFor` names what the answer
 * depends on (head, review decision, CI): the same key within a few seconds
 * reuses the answer on hand, a new one asks again. An answer already shown
 * stays up while the new one is on its way.
 */
export function askMergeEligibility(prId: string, askedFor: string): void {
  const entry = entries.get(prId);
  if (
    entry &&
    entry.askedFor === askedFor &&
    (entry.request.status === "loading" ||
      retryTimers.has(prId) ||
      Date.now() - entry.askedAt < FRESH_FOR_MS)
  ) {
    return;
  }
  clearTimeout(retryTimers.get(prId));
  retryTimers.delete(prId);
  const generation = (generations.get(prId) ?? 0) + 1;
  generations.set(prId, generation);
  setEntry(prId, {
    request: entry?.request.status === "ok" ? entry.request : RequestState.loading(),
    askedFor,
    askedAt: Date.now(),
  });
  ask(prId, generation, MAX_RETRIES);
}

function ask(prId: string, generation: number, retriesLeft: number): void {
  void getMergeEligibility(prId).then((eligibility) => {
    if (generations.get(prId) !== generation) return;
    updateEntry(prId, (entry) => ({
      ...entry,
      request: eligibility
        ? RequestState.ok(eligibility)
        : RequestState.error("Couldn't check whether this can be merged"),
      askedAt: Date.now(),
    }));
    if (eligibility && isMergeStateSettling(eligibility.mergeStateStatus) && retriesLeft > 0) {
      retryTimers.set(
        prId,
        setTimeout(() => {
          retryTimers.delete(prId);
          if (generations.get(prId) === generation) ask(prId, generation, retriesLeft - 1);
        }, RETRY_MS),
      );
    }
  });
}
