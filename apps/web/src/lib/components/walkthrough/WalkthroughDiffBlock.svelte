<script lang="ts">
import { parsePatchFiles } from "@pierre/diffs";
import { buildGitPatchHeader, type DiffBlock, splitHunks } from "@revv/shared";
import ArrowUpRight from "phosphor-svelte/lib/ArrowUpRight";
import FileBadge from "$lib/components/ui/FileBadge.svelte";
import { pierreDiff } from "$lib/pierre/mount";
import { openInDiff } from "$lib/stores/review-nav.svelte";

interface Props {
  /** The PR the walkthrough reviews; the header opens the block's file in its diff. */
  prId: string;
  block: DiffBlock;
}

let { prId, block }: Props = $props();

/** Where clicking the header lands in the Diff tab: the first hunk's new-side start. */
const targetLine = $derived(splitHunks(block.patch)[0]?.newStart ?? 1);

const fileDiff = $derived(
  parsePatchFiles(`${buildGitPatchHeader({ path: block.filePath })}\n${block.patch}`)[0]?.files[0],
);
</script>

<div class="annotated-block">
	<div class="diff-panel">
		<button class="diff-header" onclick={() => openInDiff(prId, block.filePath, targetLine)}>
			<FileBadge filePath={block.filePath} />
			<span class="diff-header-right">
				<span class="diff-jump-icon"><ArrowUpRight size={11} /></span>
			</span>
		</button>
		{#if fileDiff}
			<div
				class="diff-body"
				use:pierreDiff={{ fileDiff }}
			></div>
		{:else}
			<div class="diff-body">Failed to parse diff</div>
		{/if}
	</div>
</div>

<style>
	.annotated-block {
		display: grid;
		grid-template-columns: 1fr;
		border: 1px solid var(--revv-border);
		border-radius: 10px;
		overflow: clip;
		container-type: inline-size;
	}

	.diff-panel {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.diff-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: var(--revv-diff-bg);
		padding: 6px 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--revv-text-muted);
		width: 100%;
		border: none;
		border-bottom: 1px solid var(--revv-diff-gutter-border);
		border-radius: 0;
		cursor: pointer;
		text-align: left;
		transition: background-color var(--duration-snap) var(--ease-soft);
	}

	.diff-header:hover {
		background: color-mix(in srgb, var(--revv-accent) 8%, var(--revv-diff-bg));
	}

	.diff-header:hover .diff-jump-icon {
		opacity: 1;
	}

	.diff-header-right {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		margin-left: 8px;
	}

	.diff-jump-icon {
		display: flex;
		align-items: center;
		color: var(--revv-accent);
		opacity: 0;
		transition: opacity var(--duration-snap) var(--ease-soft);
	}

	.diff-body {
		/* Keeps the card dense under a long patch: 640px ≈ 32 lines; 70vh keeps
		   it sane on short screens. */
		max-height: min(70vh, 640px);
		overflow: auto;
	}

	@container (max-width: 600px) {
		.diff-body {
			max-height: min(80vh, 720px);
		}
	}

</style>
