// ── Pre-generation sizing ───────────────────────────────────────────────────
//
// How much attention a PR needs, and which model "Auto" would pick for it,
// resolved before any walkthrough exists so the review page can show a risk
// tier on open. The server sizes from the cached diff and caches the answer
// on `(prId, headSha, diffFingerprint)`, shared with the generation path.

import type { WalkthroughSizing } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { getPrById, getSelectedPrId } from "$lib/stores/prs.svelte";
import { authHeaders } from "$lib/utils/session-token";
import { createPendingPoll } from "./pending-poll";

/**
 * Keyed on `(prId, headSha)`, not `prId` — a pull moves the head SHA, so the
 * old answer stops matching and re-sizes rather than pinning for the branch's life.
 */
let sizings = $state<Record<string, WalkthroughSizing>>({});
/** Keys whose ask failed for real (auth, unknown PR, network): not pending, and not re-asked. */
let failed = $state<Record<string, true>>({});
/** Mount, settings change and a pull can all ask at once; `pending` re-asks. */
const poll = createPendingPoll();

function cacheKey(prId: string, headSha: string): string {
  return `${prId}@${headSha}`;
}

export function getWalkthroughSizing(
  prId: string | null,
  headSha: string | null,
): WalkthroughSizing | null {
  if (prId === null || headSha === null) return null;
  return sizings[cacheKey(prId, headSha)] ?? null;
}

/**
 * Reactive selected-PR sizing shared by the model and effort selectors.
 * `active` is read inside the effect so a saved Auto sentinel stops polling
 * once the caller's feature gate (e.g. the TypeSafe master switch) is off.
 */
export function sizingForSelectedPr(active: () => boolean) {
  let prId = $derived(getSelectedPrId());
  let headSha = $derived(prId ? (getPrById(prId)?.headSha ?? null) : null);
  let sizing = $derived(getWalkthroughSizing(prId, headSha));
  let failedHere = $derived(
    prId !== null && headSha !== null && failed[cacheKey(prId, headSha)] === true,
  );
  let pending = $derived.by(
    () =>
      active() &&
      prId !== null &&
      !failedHere &&
      (sizing === null ||
        (sizing.status === "pending" && headSha !== null && !poll.gaveUp(cacheKey(prId, headSha)))),
  );

  $effect(() => {
    if (!active() || prId === null || headSha === null || sizing !== null || failedHere) return;
    void fetchWalkthroughSizing(prId, headSha);
  });

  return {
    get sizing(): WalkthroughSizing | null {
      return sizing;
    },
    get pending(): boolean {
      return pending;
    },
  };
}

/**
 * Fetch the preview for a PR at a specific head SHA, de-duped.
 *
 * `pending` means the diff isn't cached yet (normal right after a pull), so it
 * is asked again on a timer. An HTTP error (auth, unknown PR) is not pending:
 * it is recorded as failed, so callers stop showing a pending state and show nothing.
 */
export function fetchWalkthroughSizing(prId: string, headSha: string): Promise<void> {
  const key = cacheKey(prId, headSha);
  return poll.pollWhilePending(key, async () => {
    const existing = sizings[key];
    if (existing && existing.status !== "pending") return "done";
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/reviews/${encodeURIComponent(prId)}/walkthrough/sizing`,
        { headers: authHeaders(), credentials: "include" },
      );
      if (!res.ok) {
        failed = { ...failed, [key]: true };
        return "done";
      }
      const next = (await res.json()) as WalkthroughSizing;
      sizings = { ...sizings, [key]: next };
      return next.status === "pending" ? "pending" : "done";
    } catch {
      // Best-effort: callers fall back to showing nothing.
      failed = { ...failed, [key]: true };
      return "done";
    }
  });
}

/**
 * Drop everything. Called on model/agent setting change: routing depends on
 * both, but the server still has the sizing cached, so this re-routes rather
 * than re-paying.
 */
export function resetWalkthroughSizings(): void {
  sizings = {};
  failed = {};
  poll.reset();
}
