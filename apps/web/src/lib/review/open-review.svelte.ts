import { onDestroy, untrack } from "svelte";
import { ensureHunkScan } from "$lib/hunk-scan/store.svelte";
import { getToken } from "$lib/session/token.svelte";
import { loadConversation } from "$lib/stores/conversation.svelte";
import { clearReviewFiles, getLoadedHeadSha, loadReviewFiles } from "$lib/stores/diff-files.svelte";
import { getActiveTab, switchPrViewState } from "$lib/stores/pr-view-state.svelte";
import { markVisited } from "$lib/stores/pr-visits.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import { clearSession, loadSession } from "$lib/stores/review.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { ensureStackHeadlines } from "$lib/stores/stack-headlines.svelte";
import { ensureStack, warmNeighbours } from "$lib/stores/stacks.svelte";
import { requestThreadSync } from "$lib/stores/sync.svelte";
import { fetchWalkthroughSizing, getWalkthroughSizing } from "$lib/walkthrough/sizing.svelte";
import { getRiskLevel } from "$lib/walkthrough/store.svelte";
import { useWalkthroughWatch } from "$lib/walkthrough/watch.svelte";

/** Called by the review page during its init. */
export function useOpenReview(getPrId: () => string | null): void {
  const prId = $derived(getPrId());
  const signedIn = $derived(getToken() !== null);
  // The PR row, once the lists have it (a deep link opens before they load).
  const pr = $derived(prId ? getPrById(prId) : null);

  // View state, then the review session, then the diff (installed with the
  // session's threads, so comments are on it at first paint).
  $effect(() => {
    const id = prId;
    if (!id || !signedIn) return;
    untrack(() => {
      switchPrViewState(id);
      const session = loadSession(id).catch((e) =>
        console.error("[review] Session load failed (non-blocking):", e),
      );
      void loadReviewFiles(id, session);
      void loadConversation(id);
    });
  });
  onDestroy(() => {
    // Nothing still loading may write into the next page.
    clearReviewFiles();
    clearSession();
  });

  const threadSyncPrId = $derived(pr?.id ?? null);
  $effect(() => {
    const id = threadSyncPrId;
    if (id) untrack(() => requestThreadSync(id));
  });

  // Visiting clears the sidebar dot until a new commit lands.
  $effect(() => {
    if (pr) markVisited(pr.id, pr.headSha ?? null);
  });

  useWalkthroughWatch(
    () => prId ?? "",
    () => getActiveTab() === "walkthrough",
  );

  // The risk tier from the diff, before any walkthrough has set one.
  $effect(() => {
    const id = pr?.id;
    const headSha = pr?.headSha;
    if (!id || !headSha || getRiskLevel(id) !== null) return;
    if (getWalkthroughSizing(id, headSha) !== null) return;
    void fetchWalkthroughSizing(id, headSha);
  });

  // The first pass, for the head the diff on screen was loaded against: asked
  // once that diff has loaded, which is also when the server's diff cache is
  // warm. Untracked: its rows change on every `hunk-scan:hunk`.
  const loadedHeadSha = $derived(prId ? getLoadedHeadSha(prId) : null);
  const jevEnabled = $derived(getSettings().jev.enabled);
  $effect(() => {
    const id = prId;
    const headSha = loadedHeadSha;
    if (!id || !headSha || !jevEnabled) return;
    untrack(() => void ensureHunkScan(id, headSha));
  });

  const stackPrId = $derived(pr?.stack ? pr.id : null);
  const stackNumber = $derived(pr?.stack?.number ?? null);
  $effect(() => {
    const id = stackPrId;
    const number = stackNumber;
    if (!id || number === null) return;
    let live = true;
    let cancelIdle: (() => void) | null = null;
    void untrack(() => ensureStack(id, number)).then(() => {
      if (live) cancelIdle = whenIdle(() => warmNeighbours(id));
    });
    return () => {
      live = false;
      cancelIdle?.();
    };
  });

  const stackRepositoryId = $derived(pr?.stack ? pr.repositoryId : null);
  $effect(() => {
    const repositoryId = stackRepositoryId;
    if (repositoryId) untrack(() => ensureStackHeadlines(repositoryId));
  });
}

function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 400);
  return () => clearTimeout(handle);
}
