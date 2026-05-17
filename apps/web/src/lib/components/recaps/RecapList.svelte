<script lang="ts">
import { Calendar, CircleAlert, Loader2, Sparkles } from "@lucide/svelte";
import type { ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import { goto } from "$app/navigation";
import RecapStats from "./RecapStats.svelte";

interface Props {
  repoId: string;
  recaps: ProjectRecapSummary[];
  loading: boolean;
  activePeriod: RecapPeriod | "all";
  onSetPeriod: (p: RecapPeriod | "all") => void;
  onGenerate: (p: RecapPeriod) => void;
  generating?: boolean;
}

let {
  repoId,
  recaps,
  loading,
  activePeriod,
  onSetPeriod,
  onGenerate,
  generating = false,
}: Props = $props();

let filtered = $derived(
  activePeriod === "all" ? recaps : recaps.filter((r) => r.period === activePeriod),
);

function formatPeriod(r: ProjectRecapSummary): string {
  const start = new Date(r.periodStart);
  const end = new Date(r.periodEnd);
  if (r.period === "daily") {
    return start.toUTCString().slice(0, 16); // "Mon, 12 May 2025"
  }
  // weekly: "May 12 → 19 (UTC)"
  const startStr = start.toUTCString().slice(8, 16);
  const endStr = end.toUTCString().slice(8, 16);
  return `${startStr} → ${endStr} UTC`;
}

function navigate(recapId: string): void {
  void goto(`/repo/${repoId}/recaps/${recapId}`);
}
</script>

<div class="recap-list">
	<header class="recap-list-header">
		<div class="tabs" role="tablist">
			<button
				role="tab"
				aria-selected={activePeriod === "all"}
				class:active={activePeriod === "all"}
				onclick={() => onSetPeriod("all")}
				type="button"
			>
				All
			</button>
			<button
				role="tab"
				aria-selected={activePeriod === "daily"}
				class:active={activePeriod === "daily"}
				onclick={() => onSetPeriod("daily")}
				type="button"
			>
				Daily
			</button>
			<button
				role="tab"
				aria-selected={activePeriod === "weekly"}
				class:active={activePeriod === "weekly"}
				onclick={() => onSetPeriod("weekly")}
				type="button"
			>
				Weekly
			</button>
		</div>
		<div class="actions">
			<button
				type="button"
				onclick={() => onGenerate("daily")}
				disabled={generating}
				class="generate-btn"
				title="Generate a daily recap for the most-recently-closed period"
			>
				{#if generating}
					<Loader2 size={12} class="animate-spin" />
				{:else}
					<Sparkles size={12} />
				{/if}
				<span>Generate daily</span>
			</button>
			<button
				type="button"
				onclick={() => onGenerate("weekly")}
				disabled={generating}
				class="generate-btn"
				title="Generate a weekly recap for the most-recently-closed period"
			>
				{#if generating}
					<Loader2 size={12} class="animate-spin" />
				{:else}
					<Sparkles size={12} />
				{/if}
				<span>Generate weekly</span>
			</button>
		</div>
	</header>

	{#if loading && filtered.length === 0}
		<div class="recap-empty">
			<Loader2 size={20} class="animate-spin" aria-hidden="true" />
			<p>Loading recaps…</p>
		</div>
	{:else if filtered.length === 0}
		<div class="recap-empty">
			<Calendar size={24} aria-hidden="true" />
			<p>No recaps yet for this view.</p>
			<p class="hint">
				Recaps appear automatically once at least one PR has been merged or closed
				in the current daily or weekly window (UTC). Or trigger one manually above.
			</p>
		</div>
	{:else}
		<ul class="recap-rows">
			{#each filtered as recap (recap.id)}
				<li>
					<button
						type="button"
						class="recap-row"
						class:recap-row--generating={recap.status === "generating"}
						class:recap-row--error={recap.status === "error"}
						onclick={() => navigate(recap.id)}
					>
						<div class="recap-row-head">
							<span class="period-label">{recap.period}</span>
							<span class="period-window">{formatPeriod(recap)}</span>
							<span class="status status--{recap.status}">
								{#if recap.status === "generating"}
									<Loader2 size={11} class="animate-spin" />
									generating
								{:else if recap.status === "error"}
									<CircleAlert size={11} />
									error
								{:else}
									{recap.status}
								{/if}
							</span>
						</div>
						<RecapStats stats={recap.summaryStats} />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.recap-list {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
	}

	.recap-list-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.tabs {
		display: inline-flex;
		gap: 0.125rem;
		padding: 0.125rem;
		border-radius: 0.375rem;
		background: var(--color-bg-secondary);
	}

	.tabs button {
		padding: 0.25rem 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		background: transparent;
		border: none;
		border-radius: 0.25rem;
		cursor: pointer;
		transition: background var(--duration-snap) var(--ease-out-expo);
	}

	.tabs button.active {
		background: var(--color-bg-primary);
		color: var(--color-text-primary);
	}

	.actions {
		display: inline-flex;
		gap: 0.5rem;
	}

	.generate-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		font-size: 0.75rem;
		color: var(--color-text-primary);
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.25rem;
		cursor: pointer;
		transition: background var(--duration-quick) var(--ease-out-expo);
	}

	.generate-btn:hover:not(:disabled) {
		background: var(--color-bg-hover, var(--color-bg-secondary));
	}

	.generate-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.recap-rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.recap-row {
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

	.recap-row:hover {
		background: var(--color-bg-hover, var(--color-bg-tertiary, var(--color-bg-secondary)));
	}

	.recap-row--generating {
		opacity: 0.85;
	}

	.recap-row--error {
		border-color: var(--color-border-danger, var(--color-border-subtle));
	}

	.recap-row-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--color-text-primary);
	}

	.period-label {
		text-transform: uppercase;
		font-size: 0.6875rem;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
		font-weight: 600;
	}

	.period-window {
		flex: 1;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background: var(--color-bg-primary);
		color: var(--color-text-muted);
		text-transform: lowercase;
	}

	.status--complete {
		background: var(--color-bg-success, var(--color-bg-primary));
		color: var(--color-text-success, var(--color-text-primary));
	}

	.status--error {
		color: var(--color-text-danger, var(--color-text-primary));
	}

	.recap-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		color: var(--color-text-muted);
		text-align: center;
	}

	.recap-empty .hint {
		max-width: 32rem;
		font-size: 0.8125rem;
		opacity: 0.85;
	}
</style>
