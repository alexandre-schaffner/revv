<script lang="ts">
import type { ProjectRecap, ProjectRecapSummary } from "@revv/shared";
import ChevronRight from "phosphor-svelte/lib/CaretRight";
import Sparkles from "phosphor-svelte/lib/Sparkle";
import Loader2 from "phosphor-svelte/lib/Spinner";
import { untrack } from "svelte";
import RecapStats from "$lib/components/recaps/RecapStats.svelte";
import {
  fetchRecapsForRepo,
  getRecapDetail,
  getRecapDetailLoading,
  getRecapLoading,
  getRecapsForRepo,
  loadRecap,
} from "$lib/stores/recaps.svelte";

interface Props {
  repoId: string;
}

let { repoId }: Props = $props();

let fetched = false;
$effect(() => {
  if (!fetched && repoId) {
    fetched = true;
    void untrack(() => fetchRecapsForRepo(repoId));
  }
});

const recaps = $derived(getRecapsForRepo(repoId));
const listLoading = $derived(getRecapLoading(repoId));

// Most recent non-superseded recap regardless of period.
const latest = $derived<ProjectRecapSummary | null>(
  recaps.find((r) => r.status !== "superseded") ?? null,
);
const latestId = $derived(latest?.id ?? null);

// Hydrate the full markdown for the latest recap.
$effect(() => {
  const id = latestId;
  if (id) {
    void untrack(() => loadRecap(id));
  }
});

const latestDetail = $derived<ProjectRecap | null>(latestId ? getRecapDetail(latestId) : null);
const detailLoading = $derived(latestId ? getRecapDetailLoading(latestId) : false);

const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

function periodLabel(r: ProjectRecapSummary): string {
  return r.period === "daily" ? "Daily recap" : "Weekly recap";
}

function periodWindow(r: ProjectRecapSummary): string {
  const start = new Date(r.periodStart);
  if (r.period === "daily") {
    return DAY_MONTH_YEAR.format(start);
  }
  const lastDay = new Date(new Date(r.periodEnd).getTime() - 1);
  return `${DAY_MONTH.format(start)} → ${DAY_MONTH.format(lastDay)}`;
}

// Allowlist sanitize the lede (matches RecapBody — only <strong>/<em>).
let ledeHtml = $derived.by(() => {
  const raw = latestDetail?.lede ?? "";
  const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/&lt;strong&gt;/gi, "<strong>")
    .replace(/&lt;\/strong&gt;/gi, "</strong>")
    .replace(/&lt;em&gt;/gi, "<em>")
    .replace(/&lt;\/em&gt;/gi, "</em>");
});
</script>

<section class="recap-card-section">
	<header class="recap-card-header">
		<Sparkles size={14} weight="fill" class="recap-card-icon" />
		<h2 class="recap-card-title">Latest recap</h2>
	</header>

	{#if listLoading && recaps.length === 0}
		<div class="recap-card-loading">
			<Loader2 size={16} weight="regular" class="animate-spin" aria-hidden="true" />
			<span>Loading recaps…</span>
		</div>
	{:else if !latest}
		<div class="recap-card-empty">
			<Sparkles size={16} weight="fill" aria-hidden="true" />
			<div class="recap-card-empty-body">
				<p>No recaps yet for this repo.</p>
				<a href="/repo/{repoId}/recaps" class="recap-card-empty-link">
					Generate a recap
					<ChevronRight size={12} weight="fill" />
				</a>
			</div>
		</div>
	{:else if detailLoading && !latestDetail}
		<div class="recap-card-loading">
			<Loader2 size={16} weight="regular" class="animate-spin" aria-hidden="true" />
			<span>Loading recap…</span>
		</div>
	{:else if latestDetail && latestDetail.status === "generating"}
		<div class="recap-card-paper">
			<header class="recap-card-paper-header">
				<span class="recap-card-eyebrow">{periodLabel(latest)}</span>
				<span class="recap-card-window">{periodWindow(latest)}</span>
			</header>
			<div class="recap-card-generating">
				<Loader2 size={16} weight="regular" class="animate-spin" aria-hidden="true" />
				<p>Generating recap…</p>
				<p class="hint">This page will update when the recap finishes.</p>
			</div>
		</div>
	{:else if latestDetail}
		<div class="recap-card-paper">
			<header class="recap-card-paper-header">
				<span class="recap-card-eyebrow">{periodLabel(latest)}</span>
				<span class="recap-card-window">{periodWindow(latest)}</span>
			</header>

			<div class="recap-card-stats">
				<RecapStats stats={latestDetail.summaryStats} />
			</div>

			<article class="recap-card-prose">
				{@html ledeHtml}
			</article>

			<footer class="recap-card-paper-footer">
				<a href="/repo/{repoId}/recaps" class="recap-card-view-all">
					View all recaps
					<ChevronRight size={12} weight="fill" />
				</a>
			</footer>
		</div>
	{:else}
		<div class="recap-card-paper">
			<header class="recap-card-paper-header">
				<span class="recap-card-eyebrow">{periodLabel(latest)}</span>
				<span class="recap-card-window">{periodWindow(latest)}</span>
			</header>
			<p class="recap-card-no-content">No overview content was written for this recap.</p>
			<footer class="recap-card-paper-footer">
				<a href="/repo/{repoId}/recaps" class="recap-card-view-all">
					View all recaps
					<ChevronRight size={12} weight="fill" />
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

	.recap-card-icon {
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

	/* Paper-like container — subtle shadow, border, scrollable body. */
	.recap-card-paper {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.25rem;
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border-subtle);
		border-radius: 10px;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.04),
			0 1px 3px rgba(0, 0, 0, 0.06);
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
		font-size: 0.875rem;
		line-height: 1.6;
		color: var(--color-text-primary);
	}

	.recap-card-prose :global(h1),
	.recap-card-prose :global(h2),
	.recap-card-prose :global(h3) {
		margin: 1.25em 0 0.5em;
		font-weight: 600;
		letter-spacing: -0.015em;
	}

	.recap-card-prose :global(h1) {
		font-size: 1.25em;
	}

	.recap-card-prose :global(h2) {
		font-size: 1.1em;
	}

	.recap-card-prose :global(p) {
		margin: 0.625em 0;
	}

	.recap-card-prose :global(ul),
	.recap-card-prose :global(ol) {
		margin: 0.5em 0;
		padding-left: 1.25em;
	}

	.recap-card-prose :global(li) {
		margin: 0.25em 0;
	}

	.recap-card-prose :global(code) {
		font-family: var(--font-mono, monospace);
		font-size: 0.85em;
		padding: 0.125em 0.375em;
		background: var(--color-bg-secondary);
		border-radius: 0.25em;
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
