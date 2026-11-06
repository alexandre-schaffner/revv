<script lang="ts">
import IssueCard from "$lib/components/walkthrough/IssueCard.svelte";
import IssueGroups from "$lib/components/walkthrough/IssueGroups.svelte";
import { getIssueSignal } from "$lib/stores/walkthrough.svelte";

interface Props {
  prId: string;
  filePath: string;
}

let { prId, filePath }: Props = $props();

// No disclosure here: an expander per file would out-weigh the rows it
// hides. Filtered issues stay reachable via the walkthrough and RC panel.
const issues = $derived(getIssueSignal(prId, filePath).shown);
</script>

{#if issues.length > 0}
	<div class="file-issues">
		<span class="file-issues-label">Walkthrough Issues</span>
		<IssueGroups {issues} density="compact">
			{#snippet item(issue)}
				<IssueCard {issue} />
			{/snippet}
		</IssueGroups>
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
</style>
