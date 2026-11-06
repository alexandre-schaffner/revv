// Opening a PR on the review page: its view state, its diff and its review
// session, under the lens the signed-in user has on it.

import type { ReviewMode } from "@revv/shared";
import { clearReviewFiles, loadReviewFiles } from "$lib/stores/diff-files.svelte";
import { switchPrViewState } from "$lib/stores/pr-view-state.svelte";
import { clearSession, loadSession } from "$lib/stores/review.svelte";

export function openReview(prId: string, mode: ReviewMode): void {
  switchPrViewState(prId);
  const session = loadSession(prId, mode).catch((e) =>
    console.error("[review] Session load failed (non-blocking):", e),
  );
  void loadReviewFiles(prId, mode, session);
}

/** The review page is gone: nothing still loading may write into the next one. */
export function closeReview(): void {
  clearReviewFiles();
  clearSession();
}
