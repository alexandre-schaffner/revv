<script lang="ts">
import AlertTriangle from "phosphor-svelte/lib/Warning";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import GitPullRequestClosed from "phosphor-svelte/lib/GitPullRequest";
import Users from "phosphor-svelte/lib/Users";
import type { RecapSummaryStats } from "@revv/shared";

interface Props {
  stats: RecapSummaryStats;
}

let { stats }: Props = $props();

let hasRisk = $derived(stats.riskBreakdown.medium + stats.riskBreakdown.high > 0);
</script>

<div class="recap-stats">
	<span class="stat" title="PRs in this period">
		<GitMerge size={11} weight="fill" aria-hidden="true" />
		<span>{stats.mergedCount} merged</span>
	</span>
	{#if stats.closedCount > 0}
		<span class="stat" title="Closed without merging">
			<GitPullRequestClosed size={11} aria-hidden="true" />
			<span>{stats.closedCount} closed</span>
		</span>
	{/if}
	<span class="stat" title="Distinct authors in this period">
		<Users size={11} aria-hidden="true" />
		<span>{stats.authorCount} author{stats.authorCount === 1 ? '' : 's'}</span>
	</span>
	{#if hasRisk}
		<span class="stat stat--risk" title="Walkthroughs flagged with medium/high risk">
			<AlertTriangle size={11} weight="fill" aria-hidden="true" />
			<span>
				{stats.riskBreakdown.high > 0 ? `${stats.riskBreakdown.high}H` : ''}
				{stats.riskBreakdown.medium > 0 ? `${stats.riskBreakdown.medium}M` : ''}
				risk
			</span>
		</span>
	{/if}
	{#if stats.walkthroughsMissingCount > 0}
		<span class="stat stat--missing" title="PRs in this period whose walkthrough finished after the recap ran">
			{stats.walkthroughsMissingCount} without walkthrough
		</span>
	{/if}
</div>

<style>
	.recap-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		color: var(--color-text-muted);
		font-size: 0.75rem;
	}

	.stat {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background: var(--color-bg-secondary);
	}

	.stat--risk {
		color: var(--color-text-primary);
	}

	.stat--missing {
		opacity: 0.7;
	}
</style>
