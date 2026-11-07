<script lang="ts">
import type { CodeBlock } from "@revv/shared";
import ArrowUpRight from "phosphor-svelte/lib/ArrowUpRight";
import { pierreFile } from "$lib/pierre/mount";
import { openInDiff } from "$lib/stores/review-nav.svelte";

interface Props {
  /** The PR the walkthrough reviews; the header opens the block's file in its diff. */
  prId: string;
  block: CodeBlock;
}

let { prId, block }: Props = $props();

const startLine = $derived(
  Number.isInteger(block.startLine) && block.startLine > 1 ? block.startLine : 1,
);
// Pierre sizes the gutter for 1..N; widen it for the shifted numbers.
const gutterWidth = $derived(
  startLine > 1
    ? `${String(startLine + block.content.split("\n").length - 1).length}ch`
    : undefined,
);

/**
 * Pierre's `File` numbers the gutter from 1 and has no offset option, so an
 * excerpt starting at line 240 read 1..N. Shift every number by the block's
 * start line after each render (the worker's highlight pass re-renders).
 */
function offsetLineNumbers(node: HTMLElement): void {
  for (const cell of node.shadowRoot?.querySelectorAll<HTMLElement>("[data-column-number]") ?? []) {
    const label = cell.querySelector("[data-line-number-content]");
    const n = Number(cell.dataset.columnNumber);
    if (label && Number.isInteger(n)) label.textContent = String(startLine + n - 1);
  }
}
</script>

<div class="annotated-block">
	<div class="code-panel">
		<button class="code-header" onclick={() => openInDiff(prId, block.filePath, block.startLine)}>
			<span class="code-file-path">{block.filePath}</span>
			<span class="code-header-right">
				<span class="code-line-range">:{block.startLine}-{block.endLine}</span>
				<span class="code-jump-icon"><ArrowUpRight size={11} /></span>
			</span>
		</button>
		<div
			class="code-body"
			style:--diffs-min-number-column-width={gutterWidth}
			use:pierreFile={{
				file: { name: block.filePath, contents: block.content, lang: block.language },
				onPostRender: startLine > 1 ? offsetLineNumbers : undefined,
			}}
		></div>
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

	.code-panel {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.code-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: var(--revv-diff-bg);
		border-bottom: 1px solid var(--revv-diff-gutter-border);
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

	.code-header:hover {
		background: color-mix(in srgb, var(--revv-accent) 8%, var(--revv-diff-bg));
	}

	.code-header:hover .code-jump-icon {
		opacity: 1;
	}

	.code-header-right {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
		margin-left: 8px;
	}

	.code-jump-icon {
		display: flex;
		align-items: center;
		color: var(--revv-accent);
		opacity: 0;
		transition: opacity var(--duration-snap) var(--ease-soft);
	}

	.code-file-path {
		font-weight: 500;
		color: var(--revv-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.code-line-range {
		flex-shrink: 0;
	}

	.code-body {
		/* Keeps the card dense under a 50-line snippet: 640px ≈ 32 lines at the
		   current font size; 70vh keeps it sane on short screens. */
		max-height: min(70vh, 640px);
		overflow: auto;
	}

	@container (max-width: 600px) {
		.code-body {
			max-height: min(80vh, 720px);
		}
	}

</style>
