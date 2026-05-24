<script lang="ts">
import type { ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import Loader2 from "phosphor-svelte/lib/Spinner";
import CircleAlert from "phosphor-svelte/lib/WarningCircle";
import { goto } from "$app/navigation";
import { Badge } from "$lib/components/ui/badge";
import RecapStats from "./RecapStats.svelte";

interface Props {
  repoId: string;
  period: RecapPeriod;
  /** All recaps for the repo (any period). The component filters internally. */
  recaps: ProjectRecapSummary[];
  loading: boolean;
  /** When set, this recap is excluded from the list (it's the one shown above). */
  excludeRecapId?: string | null;
}

let { repoId, period, recaps, loading, excludeRecapId = null }: Props = $props();

const periodLabel = $derived(period === "daily" ? "daily" : "weekly");

const currentRecap = $derived(recaps.find((r) => r.id === excludeRecapId));

const previous = $derived(
  recaps.filter(
    (r) =>
      r.period === period &&
      r.id !== excludeRecapId &&
      r.status !== "superseded" &&
      (!currentRecap || r.periodStart < currentRecap.periodStart),
  ),
);

// Stay invisible until there's history to show. Avoids a redundant
// "No previous recaps yet" panel sitting under the page's own primary
// empty state on brand-new repos.
const visible = $derived(loading || previous.length > 0);

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

function formatPeriod(r: ProjectRecapSummary): string {
  const start = new Date(r.periodStart);
  if (r.period === "daily") {
    return DAY_MONTH_YEAR.format(start);
  }
  const lastDay = new Date(new Date(r.periodEnd).getTime() - 1);
  return `${DAY_MONTH.format(start)} → ${DAY_MONTH.format(lastDay)} UTC`;
}

function navigate(recapId: string): void {
  void goto(`/repo/${repoId}/recaps/${recapId}`);
}
</script>

{#if visible}
<section class="previous-recaps">
	<header class="previous-recaps-header">
		<span class="eyebrow">Archive</span>
		<h2>Previous {periodLabel} recaps</h2>
	</header>

	{#if loading && previous.length === 0}
		<div class="previous-empty">
			<Loader2 size={16} weight="regular" class="motion-essential-spin" aria-hidden="true" />
			<span>Loading previous recaps…</span>
		</div>
	{:else}
		<ul class="previous-rows">
			{#each previous as recap (recap.id)}
				<li>
					<button
						type="button"
						class="previous-row"
						class:previous-row--generating={recap.status === "generating"}
						class:previous-row--error={recap.status === "error"}
						onclick={() => navigate(recap.id)}
					>
						<div class="previous-row-head">
							<span class="period-window">{formatPeriod(recap)}</span>
							{#if recap.status === "generating"}
								<Badge variant="secondary">
									<Loader2 class="motion-essential-spin" />
									generating
								</Badge>
							{:else if recap.status === "error"}
								<Badge variant="destructive" title={recap.errorMessage ?? undefined}>
									<CircleAlert />
									{recap.errorMessage ? "failed" : "error"}
								</Badge>
							{/if}
						</div>
						<RecapStats stats={recap.summaryStats} />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>
{/if}

<style>
	.previous-recaps {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--color-border-subtle);
	}

	.previous-recaps-header {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.previous-recaps-header h2 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 500;
		letter-spacing: -0.02em;
		color: var(--color-text-primary);
	}

	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: var(--color-text-muted);
	}

	.previous-rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.previous-row {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		width: 100%;
		padding: 0.625rem 0.875rem;
		text-align: left;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.5rem;
		cursor: pointer;
		transition: background var(--duration-quick) var(--ease-out-expo);
	}

	.previous-row:hover {
		background: var(--color-bg-hover, var(--color-bg-tertiary, var(--color-bg-secondary)));
	}

	.previous-row--generating {
		opacity: 0.85;
	}

	.previous-row--error {
		border-color: var(--color-border-danger, var(--color-border-subtle));
	}

	.previous-row-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--color-text-primary);
	}

	.period-window {
		flex: 1;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		letter-spacing: 0.005em;
	}

	.previous-empty {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.875rem 1rem;
		background: var(--color-bg-secondary);
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}
</style>
