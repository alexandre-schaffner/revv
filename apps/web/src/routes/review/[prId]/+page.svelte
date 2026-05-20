<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { page } from "$app/state";
import { api } from "$lib/api/client";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RequestChanges from "$lib/components/review/RequestChanges.svelte";
import ReviewLayout from "$lib/components/review/ReviewLayout.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import GuidedWalkthrough from "$lib/components/walkthrough/GuidedWalkthrough.svelte";
import { markVisited as markPrVisited } from "$lib/stores/pr-visits.svelte";
import { getSelectedPr, setSelectedPrId } from "$lib/stores/prs.svelte";
import {
  clearReviewFiles,
  getActiveFilePath,
  getActiveTab,
  getFilesError,
  getIsLoadingFiles,
  getPrScrollPosition,
  getReviewFiles,
  loadSession,
  setActiveFilePath,
  setFilesError,
  setIsLoadingFiles,
  setLoadedHeadSha,
  setPrScrollPosition,
  setReviewFiles,
  switchPrViewState,
} from "$lib/stores/review.svelte";
import { getRiskLevel as getWalkthroughRiskLevel } from "$lib/stores/walkthrough.svelte";
import { deactivate as deactivateWalkthrough } from "$lib/stores/walkthrough-stream.svelte";
import { setScrollRoot } from "$lib/stores/walkthroughNav.svelte";
import { requestThreadSync } from "$lib/stores/ws.svelte";

const pr = $derived(getSelectedPr());
const files = $derived(getReviewFiles());
const isLoading = $derived(getIsLoadingFiles());
const loadError = $derived(getFilesError());
const activeTab = $derived(getActiveTab());
const walkthroughRiskLevel = $derived(getWalkthroughRiskLevel());

const riskClasses: Record<string, string> = {
  low: "risk-badge risk-badge--low",
  medium: "risk-badge risk-badge--medium",
  high: "risk-badge risk-badge--high",
};

let scrollRootEl: HTMLDivElement | undefined = $state(undefined);

// Per-PR scroll persistence for the walkthrough / request-changes tabs.
// (Diff tab has its own scroll container inside ReviewLayout.svelte and
// persists itself there.) The `prViewStates` map in `review.svelte.ts` is
// the single source of truth: `handleScrollRootScroll` writes on every
// scroll, the `$effect` below restores once per (prId, tab) change.
function tabScrollKey(tab: string): "walkthrough" | "requestChanges" | null {
  if (tab === "walkthrough") return "walkthrough";
  if (tab === "request-changes") return "requestChanges";
  return null;
}

// Latch: the scroll handler fires immediately when we restore (because
// setting scrollTop emits a 'scroll' event), which would clobber the
// freshly-restored value with whatever the *previous* PR's scrollTop
// happened to be at that microtask. Suppress one event per restore.
let suppressNextScroll = false;

function handleScrollRootScroll(): void {
  if (suppressNextScroll) {
    suppressNextScroll = false;
    return;
  }
  const tab = activeTab;
  const prId = page.params.prId;
  if (!scrollRootEl || tab === "diff" || !prId) return;
  const key = tabScrollKey(tab);
  if (key) setPrScrollPosition(prId, key, scrollRootEl.scrollTop);
}

// Restore AFTER the DOM update (container is now visible again).
// Re-runs on tab change AND on PR change — both flows need to land at
// the right scroll offset. `restoredFor` keys on `${prId}:${tab}` so
// repeated reactive ticks for the same active tab don't refight the
// user's scrolling. We MUST clear it when the user passes through the
// diff tab: diff hides `.review-content` via display:none, and browsers
// don't reliably preserve scrollTop across that toggle — the re-entry
// into walkthrough/request-changes needs a fresh restore, otherwise
// the stamp would still match and we'd land at the top.
let restoredFor: string | null = null;
$effect(() => {
  const tab = activeTab;
  const prId = page.params.prId;
  if (!scrollRootEl || !prId) return;
  if (tab === "diff") {
    restoredFor = null;
    return;
  }
  const stamp = `${prId}:${tab}`;
  if (stamp === restoredFor) return;
  restoredFor = stamp;
  const key = tabScrollKey(tab);
  const saved = key ? getPrScrollPosition(prId, key) : 0;
  suppressNextScroll = true;
  scrollRootEl.scrollTop = saved;
});

// Register the scroll container with the walkthrough-nav store so the
// floating Top / Rating buttons in AppShell can scroll it without
// having to reach across components for the DOM ref.
$effect(() => {
  setScrollRoot(scrollRootEl ?? null);
  return () => setScrollRoot(null);
});

// Record the visit against the current head SHA so the sidebar dot
// clears now and only reappears if a new commit lands on this PR.
// Waits until the PR row is loaded for the route id — initial deep-link
// loads call setSelectedPrId() before fetchPrs() has populated the store.
$effect(() => {
  const current = pr;
  const routeId = page.params.prId;
  if (!current || !routeId || current.id !== routeId) return;
  markPrVisited(current.id, current.headSha ?? null);
});

let currentRequestId = 0;

// Phase 1 stopgap: avoid refetching diff files when the user bounces back to
// the same PR within a minute. Replaced by queryStore in Phase 3.
let lastLoadedPrId: string | null = null;
let lastLoadedAt = 0;
const PR_REFETCH_WINDOW_MS = 60_000;

$effect(() => {
  const prId = page.params.prId;
  if (!prId) return;

  // Everything below mutates store state. Calls like `clearReviewFiles()`
  // invoke `clearSession()`, which does `threadsVersion++` — a read-then-
  // write on $state. Inside an untracked block, that read doesn't subscribe
  // the effect to threadsVersion, so the write can't re-trigger us.
  untrack(() => {
    // Bump request ID so any in-flight fetch for a previous PR is ignored
    const requestId = ++currentRequestId;

    setSelectedPrId(prId);
    switchPrViewState(prId);
    requestThreadSync(prId);

    // Short-circuit: same PR, recent load, files still in memory —
    // keep rendering what's there. A WS `cache:invalidated` (Phase 3)
    // or a hard refresh will bust this.
    const now = Date.now();
    const currentFiles = getReviewFiles();
    if (
      prId === lastLoadedPrId &&
      now - lastLoadedAt < PR_REFETCH_WINDOW_MS &&
      currentFiles.length > 0
    ) {
      // Still kick off a session load so thread-counts refresh; cheap.
      loadSession(prId).catch((e) =>
        console.error("[review] Session load failed (non-blocking):", e),
      );
      return;
    }

    clearReviewFiles();
    setIsLoadingFiles(true);

    (async () => {
      try {
        // Fetch the PR's "Files changed" diff directly from GitHub via the
        // server. The diff is always baseSha...headSha (merge-base, 3-dot),
        // matching GitHub's "Files changed" tab. There is no per-commit
        // selection — the dropdown is read-only.
        const [filesResult] = await Promise.all([
          api.api.prs({ id: prId }).files.get(),
          loadSession(prId).catch((e) =>
            console.error("[review] Session load failed (non-blocking):", e),
          ),
        ]);

        if (requestId !== currentRequestId) return;

        const { data, error } = filesResult;
        if (error) throw new Error("Failed to fetch PR files");
        if (Array.isArray(data)) {
          const mapped = data.map((f) => ({
            path: f.path,
            patch: f.patch ?? null,
            additions: f.additions,
            deletions: f.deletions,
            ...(f.oldPath ? { oldPath: f.oldPath } : {}),
            ...(f.isNew ? { isNew: true as const } : {}),
            ...(f.isDeleted ? { isDeleted: true as const } : {}),
            ...(f.prerenderedHtml ? { prerenderedHtml: f.prerenderedHtml } : {}),
          }));
          setReviewFiles(mapped);
          if (mapped.length > 0) {
            // Honor the restored per-PR active file when it still exists in
            // the new diff. First-visits (path is null) and stale paths fall
            // back to file[0].
            const restored = getActiveFilePath();
            const stillExists = restored !== null && mapped.some((f) => f.path === restored);
            if (!stillExists) {
              // biome-ignore lint/style/noNonNullAssertion: mapped is non-empty here
              setActiveFilePath(mapped[0]!.path);
            }
          }
          // Stamp the SHA the diff was loaded against so the FloatingTabs
          // dot can detect when a later `prs:updated` swaps in a newer one.
          // Reading from the store captures any `prs:updated` that merged
          // mid-fetch — the server has already re-cached the diff against
          // that same SHA, so they agree.
          const currentPr = getSelectedPr();
          if (currentPr?.id === prId && currentPr.headSha) {
            setLoadedHeadSha(prId, currentPr.headSha);
          }
          lastLoadedPrId = prId;
          lastLoadedAt = Date.now();
        }
      } catch (e) {
        if (requestId !== currentRequestId) return;
        setFilesError(e instanceof Error ? e.message : "Failed to load diff");
      } finally {
        if (requestId === currentRequestId) setIsLoadingFiles(false);
      }
    })();
  });
});

onDestroy(() => {
  // Invalidate any in-flight request and clean up store state
  currentRequestId++;
  clearReviewFiles();
  // Drops the SSE subscription for this PR (so the controllers map
  // doesn't keep an orphaned, possibly-stalled handle that would block
  // the next mount from opening a fresh stream). The server-side job
  // keeps running — walkthrough generation is decoupled from which PR
  // is on screen, so two concurrent walkthroughs progress in parallel
  // even after navigating between them.
  deactivateWalkthrough();
});
</script>

<AuthGuard>
{#if isLoading}
	<div class="loading">
		<Dotmatrix variant="square-9" />
		<p>Loading diff…</p>
	</div>
{:else if loadError}
	<div class="loading error">
		<p>{loadError}</p>
	</div>
{:else if pr !== null}
	<div class="review-page">
		{#if activeTab === 'diff'}
			{#if files.length > 0}
				<ReviewLayout prId={page.params['prId'] ?? ''} {files} />
			{:else}
				<div class="loading">
					<p>No changed files in this PR</p>
				</div>
			{/if}
		{/if}

		<!-- Scroll root for walkthrough and request-changes tabs. Kept mounted
		     across diff-tab switches so the walkthrough never unmounts. -->
		<div
			class="review-content"
			class:review-content--hidden={activeTab === 'diff'}
			bind:this={scrollRootEl}
			onscroll={handleScrollRootScroll}
		>
			<div
				class="page-title-section"
				class:page-title-section--narrow={activeTab === 'walkthrough' || activeTab === 'request-changes'}
			>
				<div class="title-row">
					<h1 class="page-title">{pr.title}</h1>
				</div>
				<span class="page-subtitle">#{pr.externalId} · {pr.sourceBranch} → {pr.targetBranch}</span>
				{#if activeTab === 'walkthrough' && walkthroughRiskLevel}
					<Badge variant="outline" class={riskClasses[walkthroughRiskLevel] ?? ''}>
						{walkthroughRiskLevel} risk
					</Badge>
				{/if}
			</div>

			<!-- Walkthrough: always mounted to avoid re-render freeze on tab switch.
			     Heavy blocks (PierreFile, FileDiff, markdown) stay alive in DOM. -->
			<div class="tab-wrapper" class:tab-wrapper--hidden={activeTab !== 'walkthrough'}>
				<GuidedWalkthrough
					prId={page.params['prId'] ?? ''}
					scrollRoot={scrollRootEl}
					isActive={activeTab === 'walkthrough'}
				/>
			</div>

			<div class="tab-wrapper" class:tab-wrapper--hidden={activeTab !== 'request-changes'}>
				<RequestChanges prId={page.params['prId'] ?? ''} />
			</div>
		</div>
	</div>
{:else}
	<div class="loading">
		<Dotmatrix variant="square-9" />
		<p>Loading…</p>
	</div>
{/if}
</AuthGuard>

<style>
	.review-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		position: relative;
	}

	/* ── Scroll container for walkthrough / request-changes ──────────── */

	.review-content {
		flex: 1;
		min-height: 0;
		/* Always show the scrollbar track so the gutter is permanently reserved
		   on the right. This prevents the layout shift between tabs (walkthrough
		   has enough content to scroll; request-changes may not) — the right-side
		   column width stays constant regardless of overflow state. On macOS
		   WebKit, `overflow-y: scroll` with a non-overflowing tab renders an
		   inactive-but-present scrollbar, which is the same width as an active
		   one, so the grid never reflows. */
		overflow-y: scroll;
		scrollbar-gutter: stable;
		container-type: inline-size;
	}

	.review-content--hidden {
		display: none;
	}

	/* Tab wrappers: display:contents when active so children participate in
	   the parent's layout directly; display:none when inactive. */
	.tab-wrapper {
		display: contents;
	}

	.tab-wrapper--hidden {
		display: none;
	}

	/* ── Title section (scrolls away naturally with content) ─────────── */

	.page-title-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 76px 32px 16px;
		flex-shrink: 0;
	}

	/* Walkthrough / Request Changes tabs: title row lands on the exact same
	   6-col grid used by every container inside GuidedWalkthrough (content,
	   loading skeleton, stepper header, blocks, …). See the derivation in
	   GuidedWalkthrough.svelte → `.walkthrough-content` for the col_1 math
	   (viewport-anchored centring that stays stable under sidebar toggle/
	   resize). Template must stay byte-for-byte identical to the walkthrough
	   grids so the title above and the content below align pixel-for-pixel. */
	.page-title-section--narrow {
		display: grid;
		grid-template-columns:
			max(24px, min(calc(100% - 50vw - 458px), calc(100% - 1312px)))
			48px
			minmax(0, 820px)
			40px
			380px
			minmax(24px, 1fr);
		padding-left: 0;
		padding-right: 0;
	}

	/* `:global(*)` is required here because the Badge rendered by this section
	   (for the risk level) lives in a different Svelte component's CSS scope,
	   so a scoped `> *` selector won't match it — Svelte would rewrite the
	   child as `*.svelte-hash`, and Badge has a different hash. Without this,
	   Badge falls to grid auto-placement and lands in cols 4/5/6 (far right
	   of the title column), which is the "misplaced" symptom. */
	.page-title-section--narrow > :global(*) {
		grid-column: 3;
	}

	@container (max-width: 1335px) {
		/* Collapse the grid below the 1336-px geometric minimum of the
		   viewport-anchored layout — same breakpoint as the walkthrough's
		   own fallback (GuidedWalkthrough.svelte), so the title-section and
		   the content below always collapse together.

		   Pinned to col_3's leftmost position (col_1 floor 24 + col_2 48 =
		   72px from container left) and width-capped at the col_3 max (820)
		   plus right padding (32). At the breakpoint M=1335 this places the
		   title text at exactly 72–892 from the container's left — the same
		   span col_3 occupies at M=1336 in grid mode — so the right-pane
		   animation crossing the threshold no longer teleports the title.
		   Below 924px container width the box shrinks naturally with the
		   container; content reads narrower but never jumps. */
		.page-title-section--narrow {
			display: block;
			max-width: calc(72px + 820px + 32px);
			padding-left: 72px;
			padding-right: 32px;
			margin-inline: 0;
			box-sizing: border-box;
		}

		.page-title-section--narrow > :global(*) {
			grid-column: auto;
		}
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.page-title {
		font-size: 32px;
		font-weight: 700;
		color: var(--color-text-primary);
		line-height: 1.2;
		letter-spacing: -0.02em;
		margin: 0;
	}

	.page-subtitle {
		display: block;
		font-size: 13px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		opacity: 0.5;
		line-height: 1.4;
	}

	/* ── Risk badge (walkthrough) ─────────────────────────────────────── */

	:global(.risk-badge) {
		display: inline-flex;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		border-radius: 9999px;
		padding: 1px 6px;
		width: fit-content;
		margin-top: 6px;
	}

	/* Risk-level color modifiers. The Badge is rendered with
	   `variant="outline"` which sets `border-color: var(--color-border)` and
	   `color: var(--color-foreground)`. These modifier rules override both
	   so medium/high/low are visually distinct. Uses `color-mix` to produce
	   a translucent tinted background that works on both light and dark
	   themes without hardcoding a specific shade. !important is needed
	   because Badge's Tailwind border/text classes have equal specificity
	   and are authored later in the cascade. */
	:global(.risk-badge--low) {
		background: color-mix(in srgb, var(--color-success) 12%, transparent) !important;
		color: var(--color-success) !important;
		border-color: color-mix(in srgb, var(--color-success) 35%, transparent) !important;
	}

	:global(.risk-badge--medium) {
		background: color-mix(in srgb, var(--color-warning) 12%, transparent) !important;
		color: var(--color-warning) !important;
		border-color: color-mix(in srgb, var(--color-warning) 35%, transparent) !important;
	}

	:global(.risk-badge--high) {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent) !important;
		color: var(--color-danger) !important;
		border-color: color-mix(in srgb, var(--color-danger) 35%, transparent) !important;
	}

	.loading {
		display: flex;
		flex-direction: column;
		height: 100%;
		align-items: center;
		justify-content: center;
		gap: 12px;
		font-size: 13px;
		color: var(--color-text-muted);
	}

	.error {
		color: var(--color-danger);
	}
</style>
