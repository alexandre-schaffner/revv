<script lang="ts">
import { Dotmatrix, type DotmatrixVariant } from "$lib/components/ui/dotmatrix/index.js";
import type { FirstPassView } from "$lib/utils/hunk-scan";
import FirstPassLeads from "./FirstPassLeads.svelte";
import FirstPassRibbon from "./FirstPassRibbon.svelte";

/**
 * The first pass before any walkthrough exists. It runs on its own once the
 * diff loads, so what it found reads before Generate; the leads start open,
 * since they are the whole page.
 */
interface Props {
  view: FirstPassView;
  spinner: DotmatrixVariant;
  onjump: (filePath: string, line: number) => void;
}

let { view, spinner, onjump }: Props = $props();

let open = $state(true);
</script>

<div class="preview">
	<div class="preview-head">
		<span class="preview-title">First pass</span>
		<span class="preview-status">
			{#if view.running}
				<Dotmatrix variant={spinner} active />
				{view.scanning} hunks
			{:else}
				{view.result}
			{/if}
		</span>
	</div>
	<FirstPassRibbon rows={view.rows} height={20} />
	<FirstPassLeads
		leads={view.unraised}
		note={view.note}
		isComplete={false}
		reviewed={false}
		bind:open
		{onjump}
	/>
	<p class="preview-note">No walkthrough generated yet. Generate one and the review checks these leads.</p>
</div>

<style>
	.preview {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.preview-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.preview-title {
		font-size: var(--text-ui);
		font-weight: 500;
		color: var(--color-text-subtle);
	}

	.preview-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--text-ui);
		font-variant-numeric: tabular-nums;
		color: var(--color-text-secondary);
	}

	.preview-note {
		margin: 4px 0 0;
		font-size: var(--text-ui);
		color: var(--color-text-muted);
	}
</style>
