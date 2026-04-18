<script lang="ts">
	import { getIssuesForFile } from '$lib/stores/walkthrough.svelte';
	import IssueCard from '$lib/components/walkthrough/IssueCard.svelte';
	import { jumpToDiffLine } from '$lib/stores/review.svelte';
	import { groupIssuesBySeverity } from '$lib/utils/walkthrough-issues';

	interface Props {
		filePath: string;
	}

	let { filePath }: Props = $props();

	const issues = $derived(getIssuesForFile(filePath));
	const issueGroups = $derived(groupIssuesBySeverity(issues));
</script>

{#if issues.length > 0}
	<div class="file-issues">
		<span class="file-issues-label">Walkthrough Issues</span>
		<div class="file-issues-groups">
			{#each issueGroups as group (group.severity)}
				<div class="file-issues-group">
					<div class="file-issues-group-header file-issues-group-header--{group.severity}">
						<span class="file-issues-group-dot"></span>
						<span class="file-issues-group-label">{group.label}</span>
						<span class="file-issues-group-count">{group.issues.length}</span>
					</div>
					<div class="file-issues-list">
						{#each group.issues as issue (issue.id)}
						<IssueCard
							{issue}
							hideFileBadge={true}
							onfileclick={(path, line) => jumpToDiffLine(path, line)}
						/>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.file-issues {
		padding: 0 32px 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.file-issues-label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}

	.file-issues-groups {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.file-issues-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.file-issues-group-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-text-secondary);
	}

	.file-issues-group-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--severity-color, var(--color-text-muted));
	}

	.file-issues-group-label {
		color: var(--severity-color, var(--color-text-secondary));
	}

	.file-issues-group-count {
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
		font-weight: 500;
	}

	.file-issues-group-header--critical { --severity-color: var(--color-danger); }
	.file-issues-group-header--warning { --severity-color: var(--color-warning); }
	.file-issues-group-header--info { --severity-color: var(--color-accent); }

	.file-issues-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
</style>
