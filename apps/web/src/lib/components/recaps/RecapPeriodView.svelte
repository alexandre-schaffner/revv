<script lang="ts">
import type { ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import PenNib from "phosphor-svelte/lib/PenNib";
import Spinner from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import { Shimmer } from "$lib/components/ai/shimmer";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { fetchRecapsForRepo, getRecapLoading, getRecapsForRepo } from "$lib/stores/recaps.svelte";
import DotMatrixLoader from "./DotMatrixLoader.svelte";
import { formatRecapRange, openSpan, pickLatestByWindow } from "./period-window";
import RecapActions from "./RecapActions.svelte";
import RecapArchivePopover from "./RecapArchivePopover.svelte";
import RecapDetail from "./RecapDetail.svelte";
import { RecapController } from "./recap-controller.svelte";

interface Props {
  repoId: string;
  period: RecapPeriod;
}

let { repoId, period }: Props = $props();

const periodLabel = $derived(period === "daily" ? "Daily" : "Weekly");
const periodLabelLower = $derived(period === "daily" ? "daily" : "weekly");

// Fetch the recap list for this repo. The list reducer hydrates from SSE
// envelopes so navigating between periods doesn't re-hit the network.
$effect(() => {
  const id = repoId;
  if (id) {
    void untrack(() => fetchRecapsForRepo(id));
  }
});

const recaps = $derived(getRecapsForRepo(repoId));
const listLoading = $derived(getRecapLoading(repoId));

// Latest non-superseded recap for this period — by *window*, not by
// generation time. Generating a recap for a day three weeks back would
// otherwise hijack this hero the moment it finished.
const latest = $derived<ProjectRecapSummary | null>(pickLatestByWindow(recaps, period));
const latestId = $derived(latest?.id ?? null);

const controller = new RecapController(
  () => repoId,
  () => latestId,
);

const periodEyebrow = $derived(`${formatRecapRange(openSpan(period))} · UTC`);
const generateNoun = $derived(period === "daily" ? "today's" : "this week's");
</script>

<div class="period-view">
	{#if controller.recap}
		<RecapDetail
			recap={controller.recap}
			loading={controller.loading}
			{period}
			stream={controller.stream}
			archive={archivePopover}
		/>
	{:else if latest && controller.loading}
		<div class="loader-fullscreen">
			<DotMatrixLoader label="Loading {periodLabelLower} recap" />
		</div>
	{:else if listLoading && recaps.length === 0}
		<div class="loader-fullscreen">
			<DotMatrixLoader label="Loading recaps" />
		</div>
	{:else}
		<header class="period-hero">
			<span class="period-eyebrow">{periodEyebrow}</span>
			<h1 class="period-title">{periodLabel} recap</h1>
			<p class="period-lede">
				{#if period === "daily"}
					A snapshot of every pull request that opened, moved, or shipped
					today, written by the agent and ready in a minute.
				{:else}
					A week of pull-request activity distilled into one read: what
					shipped, what's still in flight, where the risk sits.
				{/if}
			</p>
			<div class="period-cta">
				<GlassPill
					variant="accent"
					onclick={() => controller.generate(period)}
					disabled={controller.generating}
					title="Have the agent write a fresh {periodLabelLower} recap"
				>
					{#if controller.generating}
						<Spinner size={14} class="motion-essential-spin" aria-hidden="true" />
					{:else}
						<PenNib size={16} aria-hidden="true" />
					{/if}
					<Shimmer active={!controller.generating}>
						{controller.generating
							? `Generating ${generateNoun} recap…`
							: `Generate ${generateNoun} recap`}
					</Shimmer>
				</GlassPill>
				{@render archivePopover()}
			</div>
		</header>
	{/if}
</div>

{#snippet archivePopover()}
	<RecapArchivePopover
		{repoId}
		{period}
		{recaps}
		activeRecapId={latestId}
	/>
{/snippet}

<RecapActions {controller} {period} />

<style>
	.period-view {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	/* Center the loader vertically + horizontally in the available viewport
	   while the recap (or the recap list) is loading. Approximate viewport
	   height by subtracting the app shell chrome so the loader sits in the
	   visual middle of the page area, not the middle of the document. */
	.loader-fullscreen {
		display: grid;
		place-items: center;
		min-height: calc(100vh - 8rem);
		width: 100%;
	}

	/* Editorial empty state. Mono eyebrow → display heading → lede.
	   Sized to feel like a magazine landing, not a settings card. */
	.period-hero {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.75rem;
		max-width: calc(var(--recap-measure) + 4rem);
		margin: 0 auto;
		width: 100%;
		padding: 2.5rem 2rem 4rem;
	}

	.period-eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-text-muted);
	}

	.period-title {
		margin: 0;
		text-wrap: balance;
		font-size: 2.5rem;
		font-weight: 500;
		letter-spacing: -0.02em;
		line-height: 1.02;
		color: var(--color-text-primary);
	}

	@media (max-width: 720px) {
		.period-title {
			font-size: 2rem;
		}
	}

	.period-lede {
		margin: 0.25rem 0 0;
		font-size: 0.9375rem;
		line-height: 1.55;
		color: var(--color-text-secondary);
		max-width: 34rem;
		text-wrap: pretty;
	}

	/* The page's primary action, with the archive trigger beside it — on an
	   empty repo there is no date header to hang the archive off, so it rides
	   here instead. No helper line under them: both ledes already say the
	   agent is quick. */
	.period-cta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}

</style>
