<script lang="ts">
import type { ProjectRecap, ProjectRecapSummary } from "@revv/shared";
import CalendarDots from "phosphor-svelte/lib/CalendarDots";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import Spinner from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import RecapStats from "$lib/components/recaps/RecapStats.svelte";
import { RECAP_PERIOD_COPY } from "$lib/recaps/copy";
import { formatRecapRange, pickLatestByWindow, recapSpan } from "$lib/recaps/period-window";
import {
  getRecapDetail,
  getRecapDetailLoading,
  loadRecap,
  useRecapsForRepo,
} from "$lib/recaps/store.svelte";
import { sanitizeLedeHtml } from "$lib/recaps/themes";

interface Props {
  repoId: string;
}

let { repoId }: Props = $props();

const repoRecaps = useRecapsForRepo(() => repoId);
const recaps = $derived(repoRecaps.list);
const listLoading = $derived(repoRecaps.loading);

// Most recent non-superseded recap regardless of period — by *window*, not
// by generation time, so a historical backfill doesn't take over this card.
const latest = $derived<ProjectRecapSummary | null>(pickLatestByWindow(recaps));
const latestId = $derived(latest?.id ?? null);

$effect(() => {
  const id = latestId;
  if (id) {
    void untrack(() => loadRecap(id));
  }
});

const latestDetail = $derived<ProjectRecap | null>(latestId ? getRecapDetail(latestId) : null);
const detailLoading = $derived(latestId ? getRecapDetailLoading(latestId) : false);

const ledeHtml = $derived(sanitizeLedeHtml(latestDetail?.lede ?? ""));
</script>

<section class="recap-card-section">
	<header class="recap-card-header">
		<CalendarDots size={14} class="recap-card-icon" />
		<h2 class="recap-card-title">Latest recap</h2>
	</header>

	{#if listLoading && recaps.length === 0}
		<div class="recap-card-loading">
			<Spinner size={16} class="motion-essential-spin" aria-hidden="true" />
			<span>Loading recaps…</span>
		</div>
	{:else if !latest}
		<div class="recap-card-empty">
			<CalendarDots size={16} aria-hidden="true" />
			<div class="recap-card-empty-body">
				<p>No recaps yet for this repo.</p>
				<a href="/repo/{repoId}/recaps" class="recap-card-empty-link">
					Generate a recap
					<CaretRight size={12} />
				</a>
			</div>
		</div>
	{:else if detailLoading && !latestDetail}
		<div class="recap-card-loading">
			<Spinner size={16} class="motion-essential-spin" aria-hidden="true" />
			<span>Loading recap…</span>
		</div>
	{:else if latestDetail && latestDetail.status === "generating"}
		<div class="recap-card-paper">
			<header class="recap-card-paper-header">
				<span class="recap-card-eyebrow">{RECAP_PERIOD_COPY[latest.period].title}</span>
				<span class="recap-card-window">{formatRecapRange(recapSpan(latest))}</span>
			</header>
			<div class="recap-card-generating">
				<Spinner size={16} class="motion-essential-spin" aria-hidden="true" />
				<p>Generating recap…</p>
				<p class="hint">This page will update when the recap finishes.</p>
			</div>
		</div>
	{:else if latestDetail}
		<div class="recap-card-paper">
			<header class="recap-card-paper-header">
				<span class="recap-card-eyebrow">{RECAP_PERIOD_COPY[latest.period].title}</span>
				<span class="recap-card-window">{formatRecapRange(recapSpan(latest))}</span>
			</header>

			<div class="recap-card-stats">
				<RecapStats stats={latestDetail.summaryStats} />
			</div>

			<article class="recap-card-prose prose prose-sm">
				{@html ledeHtml}
			</article>

			<footer class="recap-card-paper-footer">
				<a href="/repo/{repoId}/recaps" class="recap-card-view-all">
					View all recaps
					<CaretRight size={12} />
				</a>
			</footer>
		</div>
	{:else}
		<div class="recap-card-paper">
			<header class="recap-card-paper-header">
				<span class="recap-card-eyebrow">{RECAP_PERIOD_COPY[latest.period].title}</span>
				<span class="recap-card-window">{formatRecapRange(recapSpan(latest))}</span>
			</header>
			<p class="recap-card-no-content">No overview content was written for this recap.</p>
			<footer class="recap-card-paper-footer">
				<a href="/repo/{repoId}/recaps" class="recap-card-view-all">
					View all recaps
					<CaretRight size={12} />
				</a>
			</footer>
		</div>
	{/if}
</section>

<style>
	.recap-card-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.recap-card-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	:global(.recap-card-icon) {
		color: var(--color-accent);
		flex-shrink: 0;
	}

	.recap-card-title {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-primary);
		letter-spacing: -0.01em;
	}

	.recap-card-loading {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--color-bg-secondary);
		border-radius: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.recap-card-empty {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--color-bg-secondary);
		border-radius: 0.5rem;
		color: var(--color-text-muted);
	}

	.recap-card-empty-body {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.recap-card-empty-body p {
		margin: 0;
		font-size: 0.75rem;
	}

	.recap-card-empty-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-accent);
		text-decoration: none;
	}

	.recap-card-empty-link:hover {
		text-decoration: underline;
	}

	.recap-card-paper {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.25rem;
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-card);
		box-shadow: var(--color-shadow-sm);
		max-height: 640px;
		overflow-y: auto;
	}

	.recap-card-paper-header {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.recap-card-eyebrow {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.15em;
		color: var(--color-text-muted);
	}

	.recap-card-window {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.recap-card-stats {
		padding: 0.25rem 0;
	}

	.recap-card-generating {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		align-items: center;
		padding: 1.5rem 0;
		color: var(--color-text-secondary);
	}

	.recap-card-generating p {
		margin: 0;
		font-size: 0.8125rem;
	}

	.recap-card-generating .hint {
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.recap-card-prose {
		--tw-prose-body: var(--color-text-primary);
		max-width: 70ch;
	}

	.recap-card-prose :global(:is(h1, h2, h3)) {
		letter-spacing: -0.015em;
	}

	.recap-card-no-content {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		margin: 0;
		padding: 0.5rem 0;
	}

	.recap-card-paper-footer {
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.recap-card-view-all {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-accent);
		text-decoration: none;
	}

	.recap-card-view-all:hover {
		text-decoration: underline;
	}
</style>
