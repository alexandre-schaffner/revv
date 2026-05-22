<script lang="ts">
import type { ProjectRecap } from "@revv/shared";
import ArrowLeft from "phosphor-svelte/lib/ArrowLeft";
import CaretDown from "phosphor-svelte/lib/CaretDown";
import Loader2 from "phosphor-svelte/lib/Spinner";
import CircleAlert from "phosphor-svelte/lib/WarningCircle";
import { onMount, tick } from "svelte";
import { Shimmer } from "$lib/components/ai/shimmer";
import { ToolActivityGroup, ToolActivityReveal } from "$lib/components/ai/tool";
import { Button } from "$lib/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "$lib/components/ui/collapsible";
import type { RecapStreamEntry } from "$lib/stores/recap-stream.svelte";
import { activityToolLabel, groupActivityRuns, isActivityGroup } from "$lib/utils/activity-groups";
import { handleMarkdownLinkClick } from "$lib/utils/links";
import { createStreamingBlockRenderer, renderMarkdown } from "$lib/utils/markdown";
import RecapStats from "./RecapStats.svelte";
import ShellActivity from "./ShellActivity.svelte";

interface Props {
  recap: ProjectRecap | null;
  loading: boolean;
  /** When omitted, the back button is hidden — used on the period landing pages. */
  onBack?: (() => void) | undefined;
  /** Live stream state when the recap is generating. */
  stream?: RecapStreamEntry | null | undefined;
}

let { recap, loading, onBack = undefined, stream = null }: Props = $props();

let thoughtsOpen = $state(false);
let mounted = $state(false);
let recapProseElement = $state<HTMLElement | null>(null);
let thoughtStreamElement = $state<HTMLElement | null>(null);
let lastRevealKey = "";
let lastThoughtScrollLength = 0;
const renderThoughtBlocks = createStreamingBlockRenderer();

let completedHtml = $derived.by(() => {
  if (recap?.overview) return renderMarkdown(recap.overview);
  return "";
});

let recapActivityEntries = $derived.by(() =>
  stream?.activities ? groupActivityRuns(stream.activities) : [],
);
let thoughtText = $derived(stream?.thoughts ?? "");
let hasThoughtText = $derived(thoughtText.trim().length > 0);
let thoughtBlocks = $derived.by(() => renderThoughtBlocks(thoughtText));
let phaseLabel = $derived(
  stream ? stream.phaseMessage || phaseMessage(stream.phase) : "Starting recap…",
);

const RECAP_REVEAL_SELECTOR = "h1, h2, h3, p, li, pre, blockquote, .prose-table";

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

function activityGroupIsLatest(entry: { items: readonly { id: string }[] }): boolean {
  if (!stream?.isStreaming) return false;
  const lastActivity = stream.activities.at(-1);
  const lastGroupItem = entry.items.at(-1);
  return !!lastActivity && !!lastGroupItem && lastActivity.id === lastGroupItem.id;
}

function isBashActivity(entry: { activityKind: string; payload?: unknown }): boolean {
  return entry.activityKind === "tool.bash";
}

function extractCommand(entry: { payload?: unknown }): string {
  const obj =
    entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
      ? (entry.payload as Record<string, unknown>)
      : {};
  return typeof obj.command === "string" ? obj.command : "";
}

function revealCommittedRecap(root: HTMLElement): void {
  root.classList.remove("recap-prose-reveal-ready");
  root.classList.add("recap-prose-reveal-preparing");

  root.querySelectorAll<HTMLElement>(".recap-reveal-line").forEach((el) => {
    el.classList.remove("recap-reveal-line");
    el.style.removeProperty("--recap-line-index");
  });

  const targets = Array.from(root.querySelectorAll<HTMLElement>(RECAP_REVEAL_SELECTOR)).filter(
    (el) => {
      if (!el.textContent?.trim()) return false;
      if (el.closest(".prose-table") && !el.classList.contains("prose-table")) return false;
      return !el.parentElement?.closest(RECAP_REVEAL_SELECTOR);
    },
  );

  targets.forEach((el, index) => {
    el.style.setProperty("--recap-line-index", String(index));
    el.classList.add("recap-reveal-line");
  });

  requestAnimationFrame(() => {
    root.classList.add("recap-prose-reveal-ready");
    root.classList.remove("recap-prose-reveal-preparing");
  });
}

onMount(() => {
  mounted = true;
  return () => {
    mounted = false;
  };
});

$effect(() => {
  const revealKey =
    recap?.status === "complete" && recap.overview
      ? `${recap.id}:${recap.completedAt ?? "pending"}:${recap.overview.length}`
      : "";
  if (!mounted || !revealKey || revealKey === lastRevealKey) return;

  lastRevealKey = revealKey;
  void tick().then(() => {
    if (lastRevealKey === revealKey && recapProseElement) {
      revealCommittedRecap(recapProseElement);
    }
  });
});

$effect(() => {
  const length = thoughtText.length;
  if (!mounted || !thoughtsOpen || !thoughtStreamElement || length === lastThoughtScrollLength)
    return;

  lastThoughtScrollLength = length;
  void tick().then(() => {
    if (thoughtStreamElement && thoughtsOpen) {
      thoughtStreamElement.scrollTop = thoughtStreamElement.scrollHeight;
    }
  });
});
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
			<Loader2 size={24} weight="regular" class="animate-spin" aria-hidden="true" />
			<p>Loading recap…</p>
		</div>
	{:else if !recap}
		<div class="recap-empty">
			<CircleAlert size={24} weight="fill" aria-hidden="true" />
			<p>Recap not found.</p>
		</div>
	{:else}
		<div class="recap-stats-row">
			<RecapStats stats={recap.summaryStats} />
		</div>

		{#if recap.status === "generating"}
			{#if stream && (stream.isStreaming || stream.overview || stream.thoughts || stream.activities.length > 0)}
				<div class="recap-generating">
					<Collapsible bind:open={thoughtsOpen}>
						<CollapsibleTrigger class="phase-trigger" aria-label="{phaseLabel}. Toggle streamed thoughts">
							<Shimmer class="text-sm" aria-label={phaseLabel}>
								{phaseLabel}
							</Shimmer>
							<div class="phase-trigger-meta">
								<span>{hasThoughtText ? 'Thoughts' : 'Waiting for thoughts'}</span>
								<span class="phase-trigger-chevron-wrap" data-state={thoughtsOpen ? 'open' : 'closed'}>
									<CaretDown class="phase-trigger-chevron" aria-hidden="true" />
								</span>
							</div>
						</CollapsibleTrigger>

						<CollapsibleContent class="thought-content">
							{#if hasThoughtText}
								<div
									bind:this={thoughtStreamElement}
									class="thought-stream thought-markdown"
								>
									{#each thoughtBlocks as block (block.id)}
										<div class="thought-markdown-block">
											{@html block.html}
										</div>
									{/each}
								</div>
							{:else}
								<p class="thought-empty">No streamed thoughts yet. Tool calls below show current progress.</p>
							{/if}
						</CollapsibleContent>
					</Collapsible>

					<p class="recap-hint">
						The recap text will appear once the agent saves the final version.
					</p>
				</div>
				{#if recapActivityEntries.length > 0}
					<div class="recap-activity-stack">
						{#each recapActivityEntries as entry, entryIdx (isActivityGroup(entry) ? `group-${entry.items[0]?.id ?? entryIdx}` : entry.id)}
							{#if isActivityGroup(entry)}
								<ToolActivityGroup
									items={entry.items}
									active={activityGroupIsLatest(entry)}
									defaultOpen={false}
								/>
							{:else if isBashActivity(entry)}
								<ShellActivity
									command={extractCommand(entry)}
									summary={entry.summary}
									active={stream?.isStreaming && entry.id === stream.activities.at(-1)?.id}
								/>
							{:else}
								<div class="recap-activity-line">
									<span class="recap-activity-tool">{activityToolLabel(entry)}</span>
									{#key entry.summary}
										<ToolActivityReveal class="recap-activity-summary">
											{entry.summary}
										</ToolActivityReveal>
									{/key}
								</div>
							{/if}
						{/each}
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
				<CircleAlert size={16} weight="fill" aria-hidden="true" />
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
			<article bind:this={recapProseElement} class="recap-prose" onclick={handleMarkdownLinkClick}>
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

	.recap-generating {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		max-width: 42rem;
		padding: 0.25rem 0;
	}

	.recap-generating :global(.phase-trigger) {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.125rem 0;
		text-align: left;
	}

	.phase-trigger-meta {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.phase-trigger-chevron-wrap {
		display: inline-grid;
		place-items: center;
		transition: transform var(--duration-snap) var(--ease-out-expo);
	}

	.phase-trigger-chevron-wrap[data-state="open"] {
		transform: rotate(180deg);
	}

	.phase-trigger-chevron-wrap :global(.phase-trigger-chevron) {
		width: 0.75rem;
		height: 0.75rem;
	}

	.recap-generating :global(.thought-content) {
		overflow: hidden;
	}

	.thought-stream,
	.thought-empty {
		margin: 0.375rem 0 0;
		color: var(--color-text-muted);
	}

	.thought-stream {
		font-size: 0.875rem;
		line-height: 1.6;
	}

	.thought-markdown {
		word-break: break-word;
	}

	.thought-markdown-block + .thought-markdown-block {
		margin-top: 0.625rem;
	}

	.thought-markdown :global(p),
	.thought-markdown :global(ul),
	.thought-markdown :global(ol),
	.thought-markdown :global(pre),
	.thought-markdown :global(blockquote) {
		margin: 0 0 0.625rem;
	}

	.thought-markdown-block :global(:last-child) {
		margin-bottom: 0;
	}

	.thought-markdown :global(ul),
	.thought-markdown :global(ol) {
		padding-left: 1.25rem;
	}

	.thought-markdown :global(li) {
		margin: 0.15rem 0;
	}

	.thought-markdown :global(code) {
		font-family: var(--font-mono);
		font-size: 0.92em;
		padding: 0.08em 0.3em;
		border-radius: 0.25rem;
		background: color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent);
		color: var(--color-text-secondary);
	}

	.thought-markdown :global(pre) {
		overflow-x: auto;
		padding: 0.625rem;
		border-radius: 0.375rem;
		background: var(--color-bg-tertiary);
	}

	.thought-markdown :global(pre code) {
		padding: 0;
		background: transparent;
		font-size: inherit;
	}

	.thought-markdown :global(blockquote) {
		padding-left: 0.75rem;
		border-left: 2px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
		color: var(--color-text-secondary);
	}

	.thought-markdown :global(a) {
		color: var(--color-accent);
		text-decoration-line: underline;
		text-decoration-color: color-mix(in srgb, var(--color-accent) 35%, transparent);
		text-underline-offset: 2px;
	}

	.thought-empty {
		font-size: 0.8125rem;
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

	:global(.recap-prose.recap-prose-reveal-preparing) {
		opacity: 0;
	}

	:global(.recap-prose.recap-prose-reveal-ready) {
		opacity: 1;
	}

	:global(.recap-prose.recap-prose-reveal-ready .recap-reveal-line) {
		transform-origin: left top;
		animation: recap-reveal-line-in var(--duration-ceremonial-slow) var(--ease-out-expo) both;
		animation-delay: calc(var(--recap-line-index, 0) * var(--stagger-loose) * 1.25);
		will-change: transform, opacity;
	}

	@keyframes -global-recap-reveal-line-in {
		from {
			opacity: 0;
			transform: translateY(0.85em);
		}

		to {
			opacity: 1;
			transform: translateY(0);
		}
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
		text-align: justify;
		text-align-last: left;
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

	/* `.sd-char-new` animation lives in app.css (global) — the spans are
	   injected via `{@html}` and have no component scope. */

	.phase-shimmer {
		margin-top: 0.75rem;
	}

	.recap-activity-stack {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		max-width: 42rem;
		margin-top: 0.75rem;
	}

	.recap-activity-line {
		display: flex;
		min-width: 0;
		align-items: baseline;
		gap: 0.45rem;
		padding: 0.125rem 0;
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.recap-activity-tool {
		flex-shrink: 0;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	:global(.recap-activity-summary) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: color-mix(in srgb, var(--color-text-muted) 72%, transparent);
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
