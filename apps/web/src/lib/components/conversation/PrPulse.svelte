<script lang="ts">
import type { TimelineItem } from "@revv/shared";
import ArrowDown from "phosphor-svelte/lib/ArrowDown";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import CircleDashed from "phosphor-svelte/lib/CircleDashed";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import GitPullRequest from "phosphor-svelte/lib/GitPullRequest";
import MinusCircle from "phosphor-svelte/lib/MinusCircle";
import XCircle from "phosphor-svelte/lib/XCircle";
import Avatar from "$lib/components/shared/Avatar.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import {
  type PrPulse,
  type PulseCell,
  type PulseTone,
  pulseStateWord,
  summarizeFresh,
} from "$lib/utils/pr-pulse";

// The top of the Conversation tab: where the PR stands, in one sentence and
// four answers (checks, reviews, merge, activity), then what changed since the
// viewer last looked. Everything below it on the page is the evidence.

interface Props {
  pulse: PrPulse;
  /** Timeline items from others since the viewer's last visit. */
  fresh: readonly TimelineItem[];
  /** When that last visit was, for the "since" line. */
  seenAt: string | null;
  checksOpen: boolean;
  onChecks: () => void;
  onReviews: () => void;
  /** Absent when the merge cell has nothing to point at. */
  onMerge?: (() => void) | undefined;
  onActivity: () => void;
  onFresh: () => void;
}

let { pulse, fresh, seenAt, checksOpen, onChecks, onReviews, onMerge, onActivity, onFresh }: Props =
  $props();

const FRESH_SHOWN = 4;
// Newest first: the thing that brought the viewer back leads.
const freshLines = $derived(summarizeFresh(fresh).reverse());

const TONE_LABEL: Record<PulseTone, string> = {
  good: "OK",
  bad: "Needs attention",
  pending: "Waiting",
  neutral: "",
};
</script>

{#snippet glyph(tone: PulseTone)}
	{#if tone === 'good'}
		<CheckCircle size={15} weight="fill" />
	{:else if tone === 'bad'}
		<XCircle size={15} weight="fill" />
	{:else if tone === 'pending'}
		<CircleDashed size={15} weight="bold" />
	{:else}
		<MinusCircle size={15} />
	{/if}
{/snippet}

{#snippet cellBody(label: string, cell: PulseCell)}
	<span class="cell-label">{label}</span>
	<span class="cell-title">
		<span class="cell-glyph" aria-label={TONE_LABEL[cell.tone] || undefined}>
			{@render glyph(cell.tone)}
		</span>
		{cell.title}
	</span>
	<span class="cell-detail" title={cell.detail}>{cell.detail}</span>
{/snippet}

<section class="pulse" aria-label="Where this pull request stands">
	<div class="pulse-state">
		<span class="state-chip state-chip--{pulse.state}">
			{#if pulse.state === 'merged'}
				<GitMerge size={13} weight="bold" />
			{:else if pulse.state === 'closed'}
				<XCircle size={13} weight="bold" />
			{:else}
				<GitPullRequest size={13} weight="bold" />
			{/if}
			{pulseStateWord(pulse.state)}
		</span>
		<p class="pulse-headline pulse-headline--{pulse.headlineTone}">
			{#if pulse.actor}
				<Avatar handle={pulse.actor.login} avatarContent={pulse.actor.avatarContent} size={20} />
			{/if}
			<span>{pulse.headline}</span>
			{#if pulse.at}
				<time datetime={pulse.at} title={new Date(pulse.at).toLocaleString()}>
					{formatRelativeTime(pulse.at)}
				</time>
			{/if}
		</p>
	</div>

	<div class="pulse-cells">
		<button
			type="button"
			class="cell cell--{pulse.checks.tone}"
			aria-expanded={checksOpen}
			onclick={onChecks}
		>
			{@render cellBody('Checks', pulse.checks)}
		</button>
		<button type="button" class="cell cell--{pulse.reviews.tone}" onclick={onReviews}>
			{@render cellBody('Reviews', pulse.reviews)}
		</button>
		{#if onMerge}
			<button type="button" class="cell cell--{pulse.merge.tone}" onclick={onMerge}>
				{@render cellBody('Merge', pulse.merge)}
			</button>
		{:else}
			<div class="cell cell--{pulse.merge.tone}">
				{@render cellBody('Merge', pulse.merge)}
			</div>
		{/if}
		<button type="button" class="cell cell--activity" onclick={onActivity}>
			<span class="cell-label">Activity</span>
			<span class="cell-title">{pulse.activity.title}</span>
			<span class="cell-detail" title={pulse.activity.detail}>{pulse.activity.detail}</span>
		</button>
	</div>

	{#if fresh.length > 0 && seenAt}
		<div class="pulse-fresh">
			<span class="fresh-lead">
				<span class="fresh-dot" aria-hidden="true"></span>
				{fresh.length} new since you looked
				<time datetime={seenAt} title={new Date(seenAt).toLocaleString()}>
					{formatRelativeTime(seenAt)}
				</time>
			</span>
			<ul class="fresh-list">
				{#each freshLines.slice(0, FRESH_SHOWN) as line (line.key)}
					<li>
						<Avatar handle={line.actor.login} avatarContent={line.actor.avatarContent} size={14} />
						<span><strong>{line.actor.login}</strong> {line.text}</span>
					</li>
				{/each}
				{#if freshLines.length > FRESH_SHOWN}
					<li class="fresh-more">and {freshLines.length - FRESH_SHOWN} more</li>
				{/if}
			</ul>
			<button type="button" class="fresh-jump" onclick={onFresh}>
				<ArrowDown size={12} weight="bold" />
				Jump to new
			</button>
		</div>
	{/if}
</section>

<style>
	.pulse {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	/* ── The sentence ──────────────────────────────────────────────── */

	.pulse-state {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.state-chip {
		--chip: var(--color-accent);
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex-shrink: 0;
		height: 24px;
		padding: 0 10px 0 8px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--chip) 12%, transparent);
		color: var(--chip);
		font-size: var(--text-ui);
		letter-spacing: var(--text-ui--letter-spacing);
		font-weight: 500;
	}

	.state-chip--merged {
		--chip: var(--color-merged);
	}

	.state-chip--closed {
		--chip: var(--color-danger);
	}

	.state-chip--draft {
		--chip: var(--color-text-subtle);
	}

	.pulse-headline {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		margin: 0;
		font-size: var(--text-lg);
		line-height: var(--text-lg--line-height);
		letter-spacing: var(--text-lg--letter-spacing);
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.pulse-headline > span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pulse-headline time {
		flex-shrink: 0;
		font-size: var(--text-sm);
		letter-spacing: 0;
		font-weight: 400;
		color: var(--color-text-muted);
	}

	/* ── The four answers ─────────────────────────────────────────────
	   One band, hairline-divided, the way the repo page's activity figures
	   read: an answer per column, not a card per answer. */

	.pulse-cells {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border-block: 1px solid var(--color-border);
	}

	.cell {
		--tone: var(--color-text-muted);
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		margin: 0;
		padding: 12px 16px 13px;
		border: none;
		border-left: 1px solid var(--color-border-subtle);
		background: none;
		font: inherit;
		text-align: left;
		color: inherit;
	}

	.cell:first-child {
		border-left: none;
		padding-left: 2px;
	}

	button.cell {
		cursor: pointer;
		transition: background-color var(--duration-snap) var(--ease-soft);
	}

	button.cell:hover {
		background: color-mix(in srgb, var(--color-text-primary) 3%, transparent);
	}

	button.cell:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}

	button.cell[aria-expanded='true'] {
		background: color-mix(in srgb, var(--color-text-primary) 4%, transparent);
	}

	.cell--good {
		--tone: var(--color-success);
	}

	.cell--bad {
		--tone: var(--color-danger);
	}

	.cell--pending {
		--tone: var(--color-warning);
	}

	.cell-label {
		font-size: var(--text-ui);
		letter-spacing: var(--text-ui--letter-spacing);
		color: var(--color-text-subtle);
	}

	.cell-title {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: var(--text-base);
		line-height: var(--text-base--line-height);
		letter-spacing: var(--text-base--letter-spacing);
		font-weight: 500;
		color: var(--color-text-primary);
		white-space: nowrap;
	}

	.cell-glyph {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--tone);
	}

	.cell-detail {
		overflow: hidden;
		font-size: var(--text-ui);
		letter-spacing: var(--text-ui--letter-spacing);
		color: var(--color-text-subtle);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ── Since you looked ─────────────────────────────────────────── */

	.pulse-fresh {
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.fresh-lead {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.fresh-lead time {
		font-weight: 400;
		color: var(--color-text-muted);
	}

	.fresh-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--color-accent);
	}

	/* One line: what doesn't fit fades out under the jump button. */
	.fresh-list {
		display: flex;
		align-items: center;
		gap: 14px;
		flex: 1;
		min-width: 0;
		margin: 0;
		padding: 0;
		overflow: hidden;
		list-style: none;
		mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent);
	}

	.fresh-list strong {
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.fresh-list li {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		white-space: nowrap;
	}

	.fresh-more {
		color: var(--color-text-muted);
	}

	.fresh-jump {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: none;
		font: inherit;
		font-size: var(--text-ui);
		letter-spacing: var(--text-ui--letter-spacing);
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.fresh-jump:hover {
		border-color: var(--color-text-muted);
		color: var(--color-text-primary);
	}

	/* A narrow pane: the four answers go two by two. */
	@container (max-width: 720px) {
		.pulse-cells {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.cell:nth-child(3) {
			border-left: none;
			padding-left: 2px;
		}

		.cell:nth-child(n + 3) {
			border-top: 1px solid var(--color-border-subtle);
		}
	}
</style>
