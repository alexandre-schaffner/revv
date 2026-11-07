<script module lang="ts">
import ReviewTabs from "$lib/components/review/chrome/ReviewTabs.svelte";

// Module-level so the tabs stay mounted when the page re-mounts for another
// PR (see `useShellChrome`).
export { reviewTabs };
</script>

<script lang="ts">
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
import { useOpenReview } from "$lib/review/open-review.svelte";
import { useCommands } from "$lib/stores/commands.svelte";
import { getFilesError, getIsLoadingFiles, getReviewFiles } from "$lib/stores/diff-files.svelte";
import { getActiveTab, REVIEW_TABS, setActiveTab } from "$lib/stores/pr-view-state.svelte";
import { scrollPane } from "$lib/stores/review-nav.svelte";
import { getSelectedPr } from "$lib/stores/route.svelte";
import { getPrRiskTier } from "$lib/walkthrough/sizing.svelte";

useOpenReview(() => page.params.prId ?? null);

const pr = $derived(getSelectedPr());
const files = $derived(getReviewFiles());
const isLoading = $derived(getIsLoadingFiles());
const loadError = $derived(getFilesError());
const activeTab = $derived(getActiveTab());
const routePrIdOrEmpty = $derived(page.params.prId ?? "");
// The tier is resolved from the diff before generation, so opening a PR shows
// the attention it needs without a review. Same cached answer either way, so
// the badge value doesn't change when generation starts.
const riskTier = $derived(getPrRiskTier(routePrIdOrEmpty));

const stackPlace = $derived(activeTab === "walkthrough" && pr ? readStackPlace(pr.id) : null);

const walkthroughRiskLevel = $derived(riskTier?.level ?? null);
const riskTitle = $derived(
  riskTier?.fromReview
    ? "How much attention this pull request needs. It set the depth of the review below."
    : "How much attention this pull request needs, sized from the diff. A review has not run yet.",
);

const riskClasses: Record<string, string> = {
  low: "risk-badge risk-badge--low",
  medium: "risk-badge risk-badge--medium",
  high: "risk-badge risk-badge--high",
};

const scrollRootPane = $derived(activeTab === "diff" ? null : activeTab);

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

	<!-- Kept mounted across diff-tab switches so the walkthrough never unmounts. -->
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

		<!-- Always mounted: re-rendering its heavy blocks (Pierre, markdown) froze
		     tab switches. -->
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

	.review-content {
		flex: 1;
		min-height: 0;
		/* Reserves the scrollbar gutter so switching between a tab that scrolls
		   and one that doesn't never reflows the grid. On macOS WebKit,
		   `overflow-y: scroll` without overflow renders an inactive scrollbar of
		   the same width. */
		overflow-y: scroll;
		scrollbar-gutter: stable;
		/* The review-columns grid of both tabs sizes against this pane. */
		container: review / inline-size;
	}

	.review-content--hidden {
		display: none;
	}

	.tab-wrapper {
		display: contents;
	}

	.tab-wrapper--hidden {
		display: none;
	}

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

	/* !important: the outline Badge's Tailwind border/text classes have equal
	   specificity and come later in the cascade. */
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
