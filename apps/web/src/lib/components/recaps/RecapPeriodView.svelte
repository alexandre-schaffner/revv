<script lang="ts">
import type { ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import { RECAP_PERIOD_COPY } from "$lib/recaps/copy";
import { formatRecapRange, openSpan, pickLatestByWindow } from "$lib/recaps/period-window";
import { useRecapsForRepo } from "$lib/recaps/store.svelte";
import DotMatrixLoader from "./DotMatrixLoader.svelte";
import RecapActions from "./RecapActions.svelte";
import RecapArchivePopover from "./RecapArchivePopover.svelte";
import RecapDetail from "./RecapDetail.svelte";
import RecapGeneratePill from "./RecapGeneratePill.svelte";
import { RecapController } from "./recap-controller.svelte";

interface Props {
  repoId: string;
  period: RecapPeriod;
}

let { repoId, period }: Props = $props();

const copy = $derived(RECAP_PERIOD_COPY[period]);
const repoRecaps = useRecapsForRepo(() => repoId);
const recaps = $derived(repoRecaps.list);

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
			<DotMatrixLoader label="Loading {copy.adjective} recap" />
		</div>
	{:else if repoRecaps.loading && recaps.length === 0}
		<div class="loader-fullscreen">
			<DotMatrixLoader label="Loading recaps" />
		</div>
	{:else}
		<header class="period-hero">
			<span class="period-eyebrow">{periodEyebrow}</span>
			<h1 class="period-title">{copy.title}</h1>
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
				<RecapGeneratePill
					label="Generate {copy.current} recap"
					busyLabel="Generating {copy.current} recap…"
					title="Have the agent write a fresh {copy.adjective} recap"
					run={() => controller.generate(period)}
				/>
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

	.loader-fullscreen {
		display: grid;
		place-items: center;
		min-height: calc(100vh - 8rem);
		width: 100%;
	}

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

	/* On an empty repo there is no date header to hang the archive off, so it
	   rides beside the primary action. */
	.period-cta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}

</style>
