<script lang="ts">
import ArrowLeft from "phosphor-svelte/lib/ArrowLeft";
import CircleAlert from "phosphor-svelte/lib/WarningCircle";
import Loader2 from "phosphor-svelte/lib/Spinner";
import type { ProjectRecap } from "@revv/shared";
import { Shimmer } from "$lib/components/ai/shimmer";
import { Button } from "$lib/components/ui/button";
import type { RecapStreamEntry } from "$lib/stores/recap-stream.svelte";
import { createStreamingBlockRenderer, renderMarkdown } from "$lib/utils/markdown";
import { handleMarkdownLinkClick } from "$lib/utils/links";
import RecapStats from "./RecapStats.svelte";

interface Props {
  recap: ProjectRecap | null;
  loading: boolean;
  /** When omitted, the back button is hidden — used on the period landing pages. */
  onBack?: (() => void) | undefined;
  /** Live stream state when the recap is generating. */
  stream?: RecapStreamEntry | null | undefined;
}

let {
  recap,
  loading,
  onBack = undefined,
  stream = null,
}: Props = $props();

let completedHtml = $derived.by(() => {
  if (recap?.overview) return renderMarkdown(recap.overview);
  return "";
});

// Stateful renderer — holds per-block prev-length so the active block's
// already-shown words don't re-animate when innerHTML is replaced.
const renderStreamingBlocks = createStreamingBlockRenderer();
let streamingBlocks = $derived.by(() =>
  stream?.overview ? renderStreamingBlocks(stream.overview) : [],
);

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

function periodCadenceLabel(r: ProjectRecap): string {
  return r.period === "daily" ? "Daily recap" : "Weekly recap";
}

function periodWindowLabel(r: ProjectRecap): string {
  const start = new Date(r.periodStart);
  if (r.period === "daily") {
    return `${DAY_MONTH_YEAR.format(start)} · UTC`;
  }
  const lastDay = new Date(new Date(r.periodEnd).getTime() - 1);
  return `${DAY_MONTH.format(start)} → ${DAY_MONTH.format(lastDay)} · UTC`;
}

function phaseMessage(phase: string): string {
  const labels: Record<string, string> = {
    analyzing: "Analyzing pull requests…",
    shipped: "Writing: What shipped…",
    active_work: "Writing: Active work…",
    project_state: "Writing: Project state…",
    finalizing: "Finalizing recap…",
    connecting: "Connecting…",
  };
  return labels[phase] ?? "Generating recap…";
}

</script>

<div class="recap-detail">
	<header class="recap-detail-header">
		{#if onBack}
			<Button variant="ghost" size="sm" onclick={onBack}>
				<ArrowLeft />
				Back
			</Button>
		{/if}
		{#if recap}
			<div class="period-block">
				<span class="period-eyebrow">{periodCadenceLabel(recap)}</span>
				<h1 class="period-title">{periodWindowLabel(recap)}</h1>
			</div>
		{/if}
	</header>

	{#if loading && !recap}
		<div class="recap-loading">
			<Loader2 size={24} class="animate-spin" aria-hidden="true" />
			<p>Loading recap…</p>
		</div>
	{:else if !recap}
		<div class="recap-empty">
			<CircleAlert size={24} aria-hidden="true" />
			<p>Recap not found.</p>
		</div>
	{:else}
		<div class="recap-stats-row">
			<RecapStats stats={recap.summaryStats} />
		</div>

		{#if recap.status === "generating"}
			{#if stream && (stream.isStreaming || stream.overview)}
				<article class="recap-prose recap-prose--streaming" onclick={handleMarkdownLinkClick}>
					{#each streamingBlocks as block (block.id)}
						<div class="recap-block" data-sd-block>{@html block.html}</div>
					{/each}
				</article>
				{#if stream.isStreaming && !stream.doneReceived && !stream.streamError}
					<div class="phase-shimmer">
						<Shimmer class="text-sm" aria-label={phaseMessage(stream.phase)}>
							{phaseMessage(stream.phase)}
						</Shimmer>
					</div>
				{/if}
			{:else}
				<div class="recap-starting">
					<div class="phase-shimmer">
						<Shimmer class="text-sm" aria-label="Starting recap">Starting recap…</Shimmer>
					</div>
					<p class="recap-hint">
						This page will update automatically when the recap finishes. You can
						leave and come back.
					</p>
				</div>
			{/if}
		{:else if recap.status === "error"}
			<div class="recap-error">
				<CircleAlert size={16} aria-hidden="true" />
				<div>
					<p class="recap-error-title">
						{recap.errorMessage === "Cancelled by user"
							? "Generation stopped."
							: "Generation failed."}
					</p>
					<p class="recap-error-hint">
						{#if recap.errorMessage && recap.errorMessage !== "Cancelled by user"}
							{recap.errorMessage}
						{:else if recap.errorMessage === "Cancelled by user"}
							Click "Resume" to keep going, or "Regenerate" to start fresh.
						{:else}
							Click "Retry" to try again.
						{/if}
					</p>
				</div>
			</div>
		{:else if recap.status === "superseded"}
			<div class="recap-pending">
				<p>This recap has been replaced by a newer one for the same period.</p>
			</div>
		{:else if !recap.overview}
			<div class="recap-pending">
				<p>No overview content was written by the agent.</p>
			</div>
		{:else}
			<article class="recap-prose" onclick={handleMarkdownLinkClick}>
				{@html completedHtml}
			</article>
		{/if}

		{#if recap.completedAt && recap.status === "complete"}
			<footer class="recap-detail-footer">
				<span>
					Generated by {recap.modelUsed ?? "claude"} ·
					{recap.sourcePrIds.length} source PR{recap.sourcePrIds.length === 1
						? ""
						: "s"} · completed {new Date(recap.completedAt).toUTCString()}
				</span>
			</footer>
		{/if}
	{/if}
</div>

<style>
	.recap-detail {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: 100%;
	}

	.recap-detail-header {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	/* Editorial period title — cadence eyebrow in mono, window date in
	   display weight. Mirrors the empty-state hero in RecapPeriodView. */
	.period-block {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		flex: 1;
		min-width: 0;
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
		font-size: clamp(1.5rem, 2.6vw, 2rem);
		font-weight: 500;
		letter-spacing: -0.025em;
		line-height: 1.1;
		color: var(--color-text-primary);
	}

	.recap-stats-row {
		padding: 0.25rem 0;
	}

	.recap-pending,
	.recap-loading,
	.recap-empty {
		display: flex;
		gap: 0.625rem;
		align-items: flex-start;
		padding: 1rem 1.25rem;
		background: var(--color-bg-secondary);
		border-radius: 0.5rem;
		color: var(--color-text-secondary);
	}

	.recap-pending p {
		margin: 0;
	}

	/* Pre-stream "Starting recap…" state — drops the heavy callout in favor of
	   the same Shimmer-text treatment used by phase-shimmer below. Vertical
	   stack puts the shimmer at the same baseline as content that will follow. */
	.recap-starting {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.25rem 0;
	}

	.recap-hint {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	/* Error state — borrows the walkthrough's danger-tinted treatment so an
	   error is visually distinguishable from a passive loading callout. */
	.recap-error {
		display: flex;
		gap: 0.625rem;
		align-items: flex-start;
		padding: 0.875rem 1rem;
		background: color-mix(in srgb, var(--color-danger) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-danger) 25%, transparent);
		border-radius: 0.5rem;
		color: var(--color-text-primary);
	}

	.recap-error :global(svg) {
		color: var(--color-danger);
		flex-shrink: 0;
		margin-top: 0.15rem;
	}

	.recap-error-title {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.recap-error-hint {
		margin: 0.25rem 0 0;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.recap-prose {
		font-size: 0.9375rem;
		line-height: 1.6;
		color: var(--color-text-primary);
	}

	.recap-prose :global(h1),
	.recap-prose :global(h2),
	.recap-prose :global(h3) {
		margin: 1.5em 0 0.5em;
		font-weight: 600;
		letter-spacing: -0.015em;
	}

	.recap-prose :global(h1) {
		font-size: 1.5em;
	}

	.recap-prose :global(h2) {
		font-size: 1.2em;
	}

	.recap-prose :global(p) {
		margin: 0.75em 0;
	}

	.recap-prose :global(ul),
	.recap-prose :global(ol) {
		margin: 0.5em 0;
		padding-left: 1.5em;
	}

	.recap-prose :global(li) {
		margin: 0.25em 0;
	}

	.recap-prose :global(code) {
		font-family: var(--font-mono, monospace);
		font-size: 0.875em;
		padding: 0.125em 0.375em;
		background: var(--color-bg-secondary);
		border-radius: 0.25em;
	}

	.recap-prose :global(a) {
		color: var(--color-accent);
		text-decoration-line: underline;
		text-decoration-color: color-mix(in srgb, var(--color-accent) 35%, transparent);
		text-underline-offset: 2px;
		text-decoration-thickness: 1px;
		cursor: pointer;
		transition:
			color var(--duration-snap) var(--ease-soft),
			text-decoration-color var(--duration-snap) var(--ease-soft);
	}

	.recap-prose :global(a:hover) {
		color: var(--color-accent-hover);
		text-decoration-color: var(--color-accent-hover);
	}

	/* `.sd-word-new` animation lives in app.css (global) — the spans are
	   injected via `{@html}` and have no component scope. */

	.phase-shimmer {
		margin-top: 0.75rem;
	}

	.recap-detail-footer {
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-border-subtle);
		font-size: 0.75rem;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		letter-spacing: 0.01em;
	}

</style>
