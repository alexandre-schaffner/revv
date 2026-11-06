// Opening a PR on the review page: its view state, its diff and its review.

import { clearReviewFiles, loadReviewFiles } from "$lib/stores/diff-files.svelte";
import { switchPrViewState } from "$lib/stores/pr-view-state.svelte";
import { clearSession, loadSession } from "$lib/stores/review.svelte";

export function openReview(prId: string): void {
  switchPrViewState(prId);
  const session = loadSession(prId).catch((e) =>
    console.error("[review] Session load failed (non-blocking):", e),
  );
  void loadReviewFiles(prId, session);
}

/** The review page is gone: nothing still loading may write into the next one. */
export function closeReview(): void {
  clearReviewFiles();
  clearSession();
}
