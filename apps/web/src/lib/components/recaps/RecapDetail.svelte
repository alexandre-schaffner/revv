<script lang="ts">
import { ArrowLeft, CircleAlert, Loader2, RefreshCw } from "@lucide/svelte";
import type { ProjectRecap } from "@revv/shared";
import { Shimmer } from "$lib/components/ai/shimmer";
import { Button } from "$lib/components/ui/button";
import type { RecapStreamEntry } from "$lib/stores/recap-stream.svelte";
import { renderMarkdown } from "$lib/utils/markdown";
import RecapStats from "./RecapStats.svelte";

interface Props {
  recap: ProjectRecap | null;
  loading: boolean;
  /** When omitted, the back button is hidden — used on the period landing pages. */
  onBack?: (() => void) | undefined;
  onRegenerate: () => void;
  regenerating?: boolean;
  /** Live stream state when the recap is generating. */
  stream?: RecapStreamEntry | null | undefined;
  /**
   * Inline style for the floating Regenerate pill. Passed in by the parent
   * (RecapPeriodView or [recapId] route) so the bar tracks sidebar /
   * right-panel state without this component reading the sidebar store.
   * Defaults to a viewport-centred placement when no parent supplies it.
   */
  floatingActionsStyle?: string;
}

let {
  recap,
  loading,
  onBack = undefined,
  onRegenerate,
  regenerating = false,
  stream = null,
  floatingActionsStyle = "left: 0; right: 0;",
}: Props = $props();

let html = $derived.by(() => {
  if (stream?.overview) return renderMarkdown(stream.overview);
  if (recap?.overview) return renderMarkdown(recap.overview);
  return "";
});

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

// Show the floating Regenerate pill only when there's something to
// regenerate — a complete (or errored) recap that's not currently being
// rewritten. During `generating`, the streamer owns the screen and a
// regenerate would just restart it.
const showRegenerateFab = $derived(
  !!recap && (recap.status === "complete" || recap.status === "error"),
);
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
				<article class="recap-prose">
					{@html html}
				</article>
				{#if stream.isStreaming && !stream.doneReceived && !stream.streamError}
					<div class="phase-shimmer">
						<Loader2 size={16} class="animate-spin" aria-hidden="true" />
						<span>{phaseMessage(stream.phase)}</span>
					</div>
				{/if}
			{:else}
				<div class="recap-pending">
					<Loader2 size={18} class="animate-spin" aria-hidden="true" />
					<div>
						<p>Generating…</p>
						<p class="hint">
							This page will update automatically when the recap finishes. You
							can leave and come back.
						</p>
					</div>
				</div>
			{/if}
		{:else if recap.status === "error"}
			<div class="recap-pending recap-pending--error">
				<CircleAlert size={18} aria-hidden="true" />
				<div>
					<p>Generation failed.</p>
					<p class="hint">
						{#if recap.errorMessage}
							{recap.errorMessage}
						{:else}
							Click "Regenerate" to try again.
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
			<article class="recap-prose">
				{@html html}
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

{#if showRegenerateFab && recap}
	<div class="recap-actions-float" style={floatingActionsStyle}>
		<div class="recap-actions-row">
			<button
				type="button"
				class="recap-action-btn"
				onclick={onRegenerate}
				disabled={regenerating}
				title="Generate a fresh recap for this period (the current one becomes superseded)"
			>
				{#if regenerating}
					<Loader2 size={14} class="animate-spin" aria-hidden="true" />
				{:else}
					<RefreshCw size={14} aria-hidden="true" />
				{/if}
				<Shimmer active={!regenerating}>
					{regenerating ? "Regenerating…" : "Regenerate recap"}
				</Shimmer>
			</button>
		</div>
	</div>
{/if}

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

	.recap-pending .hint {
		margin-top: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.recap-pending--error {
		color: var(--color-text-primary);
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

	.phase-shimmer {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		margin-top: 0.5rem;
		background: var(--color-bg-secondary);
		border-radius: 0.5rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.recap-detail-footer {
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-border-subtle);
		font-size: 0.75rem;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		letter-spacing: 0.01em;
	}

	/* Floating action pill — mirrors `.walkthrough-actions-float` in
	   AppShell. Fixed positioning because this component renders inside
	   `.main-area`, which has `overflow: hidden` and no positioning
	   context of its own. Inline `left/right` is supplied by the parent
	   so the pill tracks sidebar / right-panel state from one place. */
	.recap-actions-float {
		position: fixed;
		bottom: 40px;
		display: flex;
		justify-content: center;
		z-index: 20;
		pointer-events: none;
		padding-bottom: 12px;
		transition:
			left var(--duration-smooth) var(--ease-out-expo),
			right var(--duration-instant) var(--ease-out-expo);
	}

	.recap-actions-float :global(*) {
		pointer-events: auto;
	}

	.recap-actions-row {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.recap-action-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 36px;
		padding: 0 16px;
		background: var(--color-tab-track-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		border-radius: 9999px;
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
		letter-spacing: -0.01em;
		line-height: 1.2;
		color: var(--color-text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-snap),
			color var(--duration-snap),
			box-shadow var(--duration-snap);
		-webkit-font-smoothing: antialiased;
		white-space: nowrap;
	}

	.recap-action-btn:hover {
		background: color-mix(
			in srgb,
			var(--color-tab-active-bg) 80%,
			var(--color-tab-track-bg)
		);
	}

	.recap-action-btn:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.recap-action-btn--accent:not(:disabled) {
		color: var(--color-accent);
	}

	.recap-action-btn:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}
</style>
