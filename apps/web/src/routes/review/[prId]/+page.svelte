<script module lang="ts">
import ReviewTabs from "$lib/components/review/chrome/ReviewTabs.svelte";

// Module-level so the tabs stay mounted when the page re-mounts for another
// PR (see `useShellChrome`).
export { reviewTabs };
</script>

<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { page } from "$app/state";
import ConversationTab from "$lib/components/conversation/ConversationTab.svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import WalkthroughActionBar from "$lib/components/review/chrome/WalkthroughActionBar.svelte";
import ReviewLayout from "$lib/components/review/ReviewLayout.svelte";
import { readStackPlace } from "$lib/components/stack/margin/place";
import StackPlaceLine from "$lib/components/stack/margin/StackPlaceLine.svelte";
import StackPlaceNote from "$lib/components/stack/margin/StackPlaceNote.svelte";
import StackThumbIndex from "$lib/components/stack/margin/StackThumbIndex.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import GuidedWalkthrough from "$lib/components/walkthrough/GuidedWalkthrough.svelte";
import { useWalkthroughWatch } from "$lib/components/walkthrough/walkthrough-watch.svelte";
import { closeReview, openReview } from "$lib/review/open-review";
import { getToken } from "$lib/session/token.svelte";
import { useCommands } from "$lib/stores/commands.svelte";
import { loadConversation } from "$lib/stores/conversation.svelte";
import {
  awaitReviewFiles,
  getFilesError,
  getIsLoadingFiles,
  getLoadedHeadSha,
  getReviewFiles,
} from "$lib/stores/diff-files.svelte";
import { ensureHunkScan } from "$lib/stores/hunk-scan.svelte";
import { markVisited as markPrVisited } from "$lib/stores/pr-visits.svelte";
import {
  getActiveTab,
  REVIEW_TABS,
  setActiveTab,
} from "$lib/stores/pr-view-state.svelte";
import { getReviewModeForPr, isReviewModeResolved } from "$lib/stores/prs.svelte";
import { getSelectedPr } from "$lib/stores/route.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { ensureStackHeadlines } from "$lib/stores/stack-headlines.svelte";
import { ensureStack, warmNeighbours } from "$lib/stores/stacks.svelte";
import { requestThreadSync } from "$lib/stores/sync.svelte";
import { scrollPane } from "$lib/stores/review-nav.svelte";
import { getRiskLevel as getWalkthroughRiskLevel } from "$lib/stores/walkthrough.svelte";
import {
  fetchWalkthroughSizing,
  getWalkthroughSizing,
} from "$lib/stores/walkthrough-sizing.svelte";

const pr = $derived(getSelectedPr());

const routePrId = $derived(page.params.prId ?? null);
const signedIn = $derived(getToken() !== null);
$effect(() => {
  const id = routePrId;
  if (id && signedIn) untrack(() => void loadConversation(id));
});
const threadSyncPrId = $derived(pr && pr.id === page.params.prId ? pr.id : null);
$effect(() => {
  const id = threadSyncPrId;
  if (id) untrack(() => requestThreadSync(id));
});
const reviewMode = $derived(getReviewModeForPr(page.params.prId ?? ""));
// Read through a `$derived`, never inline in the diff-load effect below:
// `isReviewModeResolved` walks both PR lists, which every `prs:updated` and
// list re-read swaps wholesale, so the effect would re-open the same PR on
// each one. A derived only propagates when the boolean itself changes.
const reviewModeResolved = $derived(isReviewModeResolved(page.params.prId ?? ""));
const files = $derived(getReviewFiles());
const isLoading = $derived(getIsLoadingFiles());
const loadError = $derived(getFilesError());
const activeTab = $derived(getActiveTab());
const routePrIdOrEmpty = $derived(page.params.prId ?? "");
useWalkthroughWatch(
  () => routePrIdOrEmpty,
  () => activeTab === "walkthrough",
);
// The tier a generated walkthrough carries. Null until one exists.
const generatedRiskLevel = $derived(getWalkthroughRiskLevel(routePrIdOrEmpty));

// …and the same tier resolved from the diff before generation, so opening a
// PR shows attention needed without a review. Same cached answer either way,
// so the badge value doesn't change when generation starts.
const sizing = $derived(getWalkthroughSizing(pr?.id ?? null, pr?.headSha ?? null));
$effect(() => {
  const prId = pr?.id;
  const headSha = pr?.headSha;
  if (!prId || !headSha || generatedRiskLevel !== null) return;
  if (sizing !== null) return;
  void fetchWalkthroughSizing(prId, headSha);
});

// The first pass, for the head the diff on screen was loaded against. Asked
// once that diff has loaded, which is also when the server's diff cache is
// warm; it runs on its own, so the Diff tab has it before any walkthrough.
// Untracked: the store's rows change on every `hunk-scan:hunk`, and reading
// them here would re-ask the server for each one.
const loadedHeadSha = $derived(getLoadedHeadSha(page.params.prId ?? ""));
const jevEnabled = $derived(getSettings().jev.enabled);
$effect(() => {
  const prId = page.params.prId;
  const headSha = loadedHeadSha;
  if (!prId || !headSha || !jevEnabled) return;
  untrack(() => void ensureHunkScan(prId, headSha));
});

const stackPrId = $derived(pr?.stack ? pr.id : null);
const stackNumber = $derived(pr?.stack?.number ?? null);
$effect(() => {
  const prId = stackPrId;
  const number = stackNumber;
  if (!prId || number === null) return;
  let live = true;
  let cancelIdle: (() => void) | null = null;
  void untrack(() => ensureStack(prId, number)).then(() => {
    if (live) cancelIdle = whenIdle(() => warmNeighbours(prId));
  });
  return () => {
    live = false;
    cancelIdle?.();
  };
});

const stackPlace = $derived(activeTab === "walkthrough" && pr ? readStackPlace(pr.id) : null);
const stackRepositoryId = $derived(pr?.stack ? pr.repositoryId : null);
$effect(() => {
  const repositoryId = stackRepositoryId;
  if (repositoryId) untrack(() => ensureStackHeadlines(repositoryId));
});

function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 400);
  return () => clearTimeout(handle);
}

const walkthroughRiskLevel = $derived(
  generatedRiskLevel ?? (sizing?.status === "ready" ? sizing.riskLevel : null),
);
// Pre-review, the tier describes the change, not a verdict — say so on hover.
const riskTitle = $derived(
  generatedRiskLevel !== null
    ? "How much attention this pull request needs. It set the depth of the review below."
    : "How much attention this pull request needs, sized from the diff. A review has not run yet.",
);

const riskClasses: Record<string, string> = {
  low: "risk-badge risk-badge--low",
  medium: "risk-badge risk-badge--medium",
  high: "risk-badge risk-badge--high",
};

const scrollRootPane = $derived(activeTab === "diff" ? null : activeTab);

// ⌘1/2/3 → the review tabs, in the order the tab bar shows them.
useCommands(
  REVIEW_TABS.map((tab, index) => ({
    id: `review:tab-${tab}`,
    label: `Show ${tab} tab`,
    keys: { key: String(index + 1) },
    hidden: true,
    run: () => setActiveTab(tab),
  })),
);

useShellChrome(() => ({
  tabs: pr ? reviewTabs : undefined,
  actions: pr && activeTab === "walkthrough" ? walkthroughActions : undefined,
}));

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

$effect(() => {
  const prId = page.params.prId;
  const mode = reviewMode;
  if (!prId) return;

  // Hold until the author-vs-reviewer lens is real. On a cold start (deep
  // link, or the desktop app reopening on this route) the PR row and the
  // signed-in user's login are both still in flight, and `reviewMode` reads
  // "reviewer" for everything — including PRs the user authored. Fetching on
  // that provisional value means the whole `/files` payload is downloaded
  // twice, which on a 3 000-file PR is two ~12 MB responses back to back.
  if (!reviewModeResolved) {
    untrack(awaitReviewFiles);
    return;
  }

  untrack(() => openReview(prId, mode));
});

onDestroy(() => {
  closeReview();
});
</script>

{#snippet reviewTabs()}
	<ReviewTabs />
{/snippet}

{#snippet walkthroughActions()}
	{#if pr}
		<WalkthroughActionBar prId={pr.id} />
	{/if}
{/snippet}

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

	<!-- Scroll root for walkthrough and conversation tabs. Kept mounted
	     across diff-tab switches so the walkthrough never unmounts. -->
	<div
		class="review-content"
		class:review-content--hidden={activeTab === 'diff'}
		use:scrollPane={{ prId: routePrIdOrEmpty, pane: scrollRootPane }}
	>
		<div class="page-title-section review-columns">
			<h1 class="page-title">{pr.title}</h1>
			<span class="page-subtitle">#{pr.externalId} · {pr.sourceBranch} → {pr.targetBranch}</span>
			{#if stackPlace}
				<div class="title-stack-line"><StackPlaceLine place={stackPlace} /></div>
			{/if}
			{#if activeTab === 'walkthrough' && walkthroughRiskLevel}
				<Badge
					variant="outline"
					class={riskClasses[walkthroughRiskLevel] ?? ''}
					title={riskTitle}
				>
					{walkthroughRiskLevel} risk
				</Badge>
			{/if}
			{#if stackPlace}
				<div class="title-stack-thumb"><StackThumbIndex place={stackPlace} /></div>
				<div class="title-stack-note"><StackPlaceNote place={stackPlace} /></div>
			{/if}
		</div>

		<!-- Walkthrough: always mounted to avoid re-render freeze on tab switch.
		     Heavy blocks (PierreFile, FileDiff, markdown) stay alive in DOM. -->
		<div class="tab-wrapper" class:tab-wrapper--hidden={activeTab !== 'walkthrough'}>
			<GuidedWalkthrough prId={routePrIdOrEmpty} />
		</div>

		<div class="tab-wrapper" class:tab-wrapper--hidden={activeTab !== 'conversation'}>
			<ConversationTab
				prId={page.params['prId'] ?? ''}
				isActive={activeTab === 'conversation'}
			/>
		</div>
	</div>
</div>
{:else}
<div class="loading">
	<Dotmatrix variant="square-9" />
	<p>Loading…</p>
</div>
{/if}

<style>
	.review-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		position: relative;
	}

	/* ── Scroll container for walkthrough / conversation ───────────── */

	.review-content {
		flex: 1;
		min-height: 0;
		/* Always show the scrollbar track so the gutter is permanently reserved
		   on the right. This prevents the layout shift between tabs (walkthrough
		   has enough content to scroll; conversation may not) — the right-side
		   column width stays constant regardless of overflow state. On macOS
		   WebKit, `overflow-y: scroll` with a non-overflowing tab renders an
		   inactive-but-present scrollbar, which is the same width as an active
		   one, so the grid never reflows. */
		overflow-y: scroll;
		scrollbar-gutter: stable;
		/* The review-columns grid of both tabs sizes against this pane. */
		container: review / inline-size;
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
		row-gap: 4px;
		padding: 76px 0 16px;
		flex-shrink: 0;
	}

	.page-title-section > .title-stack-thumb,
	.page-title-section > .title-stack-note {
		grid-row: 1;
		align-self: start;
		position: relative;
		z-index: 3;
		height: 0;
	}

	.page-title-section > .title-stack-thumb {
		grid-column: 2;
		display: flex;
		justify-content: flex-end;
		padding: 9px 14px 0 0;
	}

	.page-title-section > .title-stack-note {
		grid-column: 5;
		padding-top: 9px;
	}

	.page-title-section > .title-stack-line {
		display: none;
		min-width: 0;
	}

	@container review (max-width: 1335px) {
		.page-title-section > .title-stack-thumb {
			grid-column: 1;
		}

		.page-title-section > .title-stack-note {
			display: none;
		}

		.page-title-section > .title-stack-line {
			display: block;
		}
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
