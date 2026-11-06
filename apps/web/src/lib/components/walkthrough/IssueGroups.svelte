<script lang="ts">
import type { WalkthroughIssue } from "@revv/shared";
import type { Snippet } from "svelte";
import { groupIssuesBySeverityWithIndex } from "$lib/utils/walkthrough-issues";

/**
 * Issues bucketed by severity, Critical → Warning → Info, each bucket under a
 * labelled header with its count. The caller renders each issue; the second
 * snippet argument is its position across all groups, for a cascade that
 * doesn't restart per group.
 */
interface Props {
  issues: readonly WalkthroughIssue[];
  /** `compact` for the per-file strip in the diff tab. */
  density?: "comfortable" | "compact";
  item: Snippet<[WalkthroughIssue, number]>;
}

let { issues, density = "comfortable", item }: Props = $props();

const groups = $derived(groupIssuesBySeverityWithIndex(issues));
</script>

<div class="issue-groups" class:issue-groups--compact={density === 'compact'}>
	{#each groups as group (group.severity)}
		<div class="issue-group">
			<div class="issue-group-header issue-group-header--{group.severity}">
				<span class="issue-group-dot"></span>
				<span class="issue-group-label">{group.label}</span>
				<span class="issue-group-count">{group.issues.length}</span>
			</div>
			<div class="issue-group-list">
				{#each group.issues as { issue, globalIndex } (issue.id)}
					{@render item(issue, globalIndex)}
				{/each}
			</div>
		</div>
	{/each}
</div>

<style>
	.issue-groups {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.issue-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.issue-group-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-secondary);
	}

	.issue-group-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--severity-color, var(--color-text-muted));
	}

	.issue-group-label {
		color: var(--severity-color, var(--color-text-secondary));
	}

	.issue-group-count {
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		font-weight: 500;
	}

	.issue-group-header--critical { --severity-color: var(--color-danger); }
	.issue-group-header--warning { --severity-color: var(--color-warning); }
	.issue-group-header--info { --severity-color: var(--color-accent); }

	.issue-group-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.issue-groups--compact {
		gap: 10px;
	}

	.issue-groups--compact .issue-group-list {
		gap: 6px;
	}
</style>
