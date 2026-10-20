<script lang="ts">
/*
 * RepoActivitySection — the repo homepage's numbers: a row of KPIs over the
 * last week, then the year-long commit heatmap.
 *
 * The KPIs mix three sources on purpose, each where it is honest:
 *   - PR flow (merged, opened, time to merge) from GitHub search, because
 *     Revv's own mirror only reaches back to when the repo was added;
 *   - "waiting on you" from the live PR store, which is always current;
 *   - commits from the same statistics the heatmap draws.
 * Each tile renders on its own; a source still loading shows a skeleton and
 * one that failed shows a dash, never a zero that would read as a fact.
 */

import { loginsMatch } from "@revv/shared";
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import ArrowDownRight from "phosphor-svelte/lib/ArrowDownRight";
import ArrowUpRight from "phosphor-svelte/lib/ArrowUpRight";
import { untrack } from "svelte";
import RepoActivityChart from "$lib/components/repo/RepoActivityChart.svelte";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { getTaggedPrs } from "$lib/stores/prs.svelte";
import { getRepoActivity, loadRepoActivity } from "$lib/stores/repo-activity.svelte";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import type { OwnerPalette } from "$lib/utils/avatarPalette";
import { repoInkRamp } from "$lib/utils/repo-ink";

interface Props {
  repoId: string;
  /** The owner's palette, which the hero above prints in. */
  palette: OwnerPalette;
}

let { repoId, palette }: Props = $props();

/** Four steps of the repo's ink, faint to full. */
const ramp = $derived(repoInkRamp(palette, getResolvedTheme()));

$effect(() => {
  const id = repoId;
  untrack(() => void loadRepoActivity(id));
});

const entry = $derived(getRepoActivity(repoId));
const data = $derived(entry.status === "ok" ? entry.data : null);
const commits = $derived(data?.commits ?? null);
const flow = $derived(data?.flow ?? null);
const flowLoading = $derived(entry.status === "idle" || entry.status === "loading");
const commitsLoading = $derived(flowLoading || data?.commitsPending === true);

const FULL = new Intl.NumberFormat("en-US");
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Waiting on you ───────────────────────────────────────────────────────

const waiting = $derived.by(() => {
  const login = getCurrentUserLogin();
  if (!login) return null;
  return getTaggedPrs(repoId).filter(
    (pr) => !pr.isDraft && pr.requestedReviewers.some((r) => loginsMatch(r, login)),
  );
});

const oldestWaitDays = $derived.by(() => {
  if (!waiting || waiting.length === 0) return null;
  const oldest = Math.min(...waiting.map((pr) => Date.parse(pr.createdAt)));
  return Math.floor((Date.now() - oldest) / DAY_MS);
});

// ── Commits this week, from the heatmap's own numbers ────────────────────

const commitWeeks = $derived.by(() => {
  if (!commits) return null;
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  let last = 0;
  let prev = 0;
  for (const week of commits.weeks) {
    const start = Date.parse(week.weekStart);
    week.days.forEach((n, i) => {
      const age = (today - (start + i * DAY_MS)) / DAY_MS;
      if (age >= 0 && age < 7) last += n;
      else if (age >= 7 && age < 14) prev += n;
    });
  }
  return { last, prev };
});

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)}d`;
}

interface Tile {
  key: string;
  label: string;
  value: string | null;
  /** The tile's source is still in flight: draw a skeleton, not a dash. */
  loading: boolean;
  /** Signed change against the prior period, when the tile has one. */
  delta?: number | null;
  note: string;
  /** Hover detail for the whole tile. */
  title?: string;
  bars?: number[];
}

const tiles = $derived<Tile[]>([
  {
    key: "merged",
    label: "Merged",
    value: flow ? FULL.format(flow.mergedLast7d) : null,
    loading: flowLoading,
    delta: flow ? flow.mergedLast7d - flow.mergedPrev7d : null,
    note: "last 7 days",
    ...(flow ? { bars: flow.mergedPerWeek } : {}),
  },
  {
    key: "opened",
    label: "Opened",
    value: flow ? FULL.format(flow.openedLast7d) : null,
    loading: flowLoading,
    delta: flow ? flow.openedLast7d - flow.openedPrev7d : null,
    note: "last 7 days",
  },
  {
    key: "ttm",
    label: "Time to merge",
    value: flow
      ? flow.medianHoursToMerge === null
        ? "–"
        : formatDuration(flow.medianHoursToMerge)
      : null,
    loading: flowLoading,
    note: "median, last 4 weeks",
    ...(flow
      ? {
          title: `Median over ${FULL.format(flow.medianSample)} of ${FULL.format(flow.mergedLast28d)} merges`,
        }
      : {}),
  },
  {
    key: "waiting",
    label: "Waiting on you",
    value: waiting ? FULL.format(waiting.length) : null,
    loading: false,
    note:
      oldestWaitDays === null
        ? "review requests"
        : oldestWaitDays === 0
          ? "oldest opened today"
          : `oldest ${oldestWaitDays}d old`,
  },
  {
    key: "commits",
    label: "Commits",
    value: commitWeeks ? FULL.format(commitWeeks.last) : null,
    loading: commitsLoading,
    delta: commitWeeks ? commitWeeks.last - commitWeeks.prev : null,
    note: "last 7 days",
    ...(flow
      ? { title: `${FULL.format(flow.authorsLast28d)} people merged PRs in the last 4 weeks` }
      : {}),
  },
]);

const errorMessage = $derived(entry.status === "error" ? entry.error : null);
const commitsGaveUp = $derived(data !== null && data.commits === null && !data.commitsPending);
</script>

<section class="activity-section" aria-labelledby="activity-{repoId}">
	<header class="head">
		<h3 class="title" id="activity-{repoId}">Activity</h3>
		{#if errorMessage || commitsGaveUp}
			<p class="status">
				{errorMessage ?? "GitHub is still computing this repo's statistics."}
				<button class="retry" type="button" onclick={() => loadRepoActivity(repoId)}>
					<ArrowClockwise size={12} />
					Retry
				</button>
			</p>
		{/if}
	</header>

	<dl class="tiles">
		{#each tiles as tile (tile.key)}
			<div class="tile" title={tile.title}>
				<dt>{tile.label}</dt>
				<dd class="value">
					{#if tile.value === null && tile.loading}
						<span class="skeleton value-skeleton" role="img" aria-label="Loading"></span>
					{:else}
						{tile.value ?? "–"}
					{/if}
					{#if tile.delta}
						<span class="delta" title="vs the 7 days before">
							{#if tile.delta > 0}<ArrowUpRight size={11} weight="bold" />{:else}<ArrowDownRight size={11} weight="bold" />{/if}
							{FULL.format(Math.abs(tile.delta))}
						</span>
					{/if}
				</dd>
				<dd class="note">
					{#if tile.bars}
						{@const max = Math.max(1, ...tile.bars)}
						<span class="spark" aria-hidden="true">
							{#each tile.bars as n, i (i)}
								<i
									style:height="{Math.max(2, (n / max) * 12)}px"
									style:background={i === tile.bars.length - 1 ? ramp[3] : ramp[0]}
								></i>
							{/each}
						</span>
					{/if}
					{tile.note}
				</dd>
			</div>
		{/each}
	</dl>

	<RepoActivityChart weeks={commits?.weeks ?? null} loading={commitsLoading} {ramp} />
</section>

<style>
	.activity-section {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
	}

	.title {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.status {
		margin: 0;
		display: inline-flex;
		align-items: baseline;
		gap: 8px;
		font-size: 12px;
		color: var(--color-text-muted);
	}

	.retry {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: var(--color-accent);
		cursor: pointer;
	}

	/* Stat tiles share hairlines rather than sitting in boxes: five numbers
	   read as one row of facts, not five cards. */
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
		margin: 0;
		border-top: 1px solid var(--color-border-subtle);
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 14px 16px 14px 0;
		min-width: 0;
	}

	.tile + .tile {
		padding-left: 16px;
		border-left: 1px solid var(--color-border-subtle);
	}

	dt {
		font-size: 11px;
		color: var(--color-text-muted);
	}

	dd {
		margin: 0;
	}

	.value {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 22px;
		font-weight: 600;
		line-height: 1.1;
		min-height: 1.1em;
		color: var(--color-text-primary);
	}

	/* Cap height of the 22px figures, so the row doesn't move when they land. */
	.value-skeleton {
		align-self: center;
		width: 44px;
		height: 18px;
		margin-block: 3px;
	}

	.delta {
		display: inline-flex;
		align-items: center;
		gap: 1px;
		font-size: 11px;
		font-weight: 500;
		color: var(--color-text-secondary);
	}

	.note {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		font-size: 11px;
		color: var(--color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.spark {
		display: inline-flex;
		align-items: flex-end;
		gap: 2px;
		height: 12px;
		flex-shrink: 0;
	}

	.spark i {
		display: block;
		width: 4px;
		border-radius: 1px;
	}
</style>
