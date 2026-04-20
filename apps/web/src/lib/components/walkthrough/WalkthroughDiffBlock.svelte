<script lang="ts">
	import type { DiffBlock } from '@revv/shared';
	import { FileDiff, parsePatchFiles, type FileDiffOptions } from '@pierre/diffs';
	import { workerManager } from '$lib/utils/worker-pool';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { jumpToDiffLine } from '$lib/stores/review.svelte';
	import { ArrowUpRight } from '@lucide/svelte';
	import FileBadge from '$lib/components/ui/FileBadge.svelte';

	interface Props {
		block: DiffBlock;
		themeType: 'light' | 'dark' | 'system';
		hideAnnotation?: boolean;
	}

	let { block, themeType, hideAnnotation = false }: Props = $props();

	const renderedAnnotation = $derived(
		block.annotation ? renderMarkdown(block.annotation) : null
	);

	/**
	 * First added-line number from the first hunk header, used as the jump target
	 * when the user clicks the header to open this file in the Diff tab. Falls
	 * back to line 1 if the patch has no parseable hunk header.
	 */
	const targetLine = $derived.by(() => {
		const match = block.patch.match(/^@@[^\n]*?\+(\d+)/m);
		return match?.[1] ? parseInt(match[1], 10) : 1;
	});

	let instance: FileDiff<never> | null = null;

	$effect(() => {
		instance?.setThemeType(themeType);
	});

	function mountDiffBlock(el: HTMLDivElement) {
		const options: FileDiffOptions<never> = {
			diffStyle: 'unified',
			theme: { dark: 'pierre-dark', light: 'pierre-light' },
			themeType,
			overflow: 'scroll',
			// Suppress Pierre's built-in file header — we render our own clickable
			// header above so the user can jump to this file in the Diff tab.
			disableFileHeader: true,
		};

		instance = new FileDiff<never>(options, workerManager);

		const patchHeader = [
			`diff --git a/${block.filePath} b/${block.filePath}`,
			`--- a/${block.filePath}`,
			`+++ b/${block.filePath}`,
		].join('\n');
		const fullPatch = `${patchHeader}\n${block.patch}`;
		const parsed = parsePatchFiles(fullPatch)[0]?.files[0];

		if (!parsed) {
			el.textContent = 'Failed to parse diff';
			return { destroy() {} };
		}

		instance.render({ containerWrapper: el, fileDiff: parsed });

		return {
			destroy() {
				instance?.cleanUp();
				instance = null;
			},
		};
	}
</script>

<div class="annotated-block" class:annotated-block--no-annotation={!block.annotation || hideAnnotation}>
	{#if !hideAnnotation && block.annotation && block.annotationPosition === 'left'}
		<div class="annotation annotation--left">
			<div class="annotation-content">
				{@html renderedAnnotation}
			</div>
		</div>
	{/if}

	<div class="diff-panel">
		<button class="diff-header" onclick={() => jumpToDiffLine(block.filePath, targetLine)}>
			<FileBadge filePath={block.filePath} />
			<span class="diff-header-right">
				<span class="diff-jump-icon"><ArrowUpRight size={11} /></span>
			</span>
		</button>
		<div class="diff-body" use:mountDiffBlock></div>
	</div>

	{#if !hideAnnotation && block.annotation && block.annotationPosition === 'right'}
		<div class="annotation annotation--right">
			<div class="annotation-content">
				{@html renderedAnnotation}
			</div>
		</div>
	{/if}
</div>

<style>
	.annotated-block {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border: 1px solid var(--revv-border);
		border-radius: 10px;
		/* overflow: clip clips like `hidden` but does NOT create a scroll container,
		   so descendant `position: sticky` inside .annotation-content keeps tracking
		   page scroll. */
		overflow: clip;
		container-type: inline-size;
	}

	.annotated-block--no-annotation {
		grid-template-columns: 1fr;
	}

	.annotation {
		display: flex;
		align-items: flex-start;
		padding: 16px 20px;
		background: var(--revv-bg-secondary);
		font-size: 14px;
		line-height: 1.6;
		color: var(--revv-text-secondary);
	}

	.annotation--left {
		border-right: 2px solid var(--revv-accent);
	}

	.annotation--right {
		border-left: 2px solid var(--revv-accent);
	}

	.annotation-content {
		width: 100%;
		/* Sticky pins the annotation text to the top of the viewport as the card
		   scrolls past, while the surrounding .annotation cell background still
		   fills the full grid row for the card look. `overflow: clip` on the
		   .annotated-block ancestor ensures sticky works across the card. */
		position: sticky;
		top: 16px;
		align-self: flex-start;
		max-height: calc(100vh - 32px);
		overflow-y: auto;
	}

	.annotation-content :global(p) {
		margin: 0 0 8px;
	}

	.annotation-content :global(p:last-child) {
		margin-bottom: 0;
	}

	.annotation-content :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--revv-bg-tertiary);
		padding: 1px 4px;
		border-radius: 3px;
	}

	.annotation-content :global(strong) {
		color: var(--revv-text-primary);
		font-weight: 600;
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
		transition: background-color 120ms ease;
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
		transition: opacity 120ms ease;
	}

	.diff-body {
		/* Cap the diff panel so the card stays dense even when the patch is long
		   beside a short annotation. 640px ≈ 32 lines; 70vh keeps it sane on
		   short screens. Pierre's own overflow option handles horizontal scroll
		   for long lines. */
		max-height: min(70vh, 640px);
		overflow: auto;
	}

	/* Narrow: stack vertically */
	@container (max-width: 600px) {
		.annotated-block {
			grid-template-columns: 1fr;
		}

		.annotation--left {
			border-right: none;
			border-bottom: 2px solid var(--revv-accent);
		}

		.annotation--right {
			border-left: none;
			border-top: 2px solid var(--revv-accent);
		}

		/* Sticky is noisy when stacked — annotation would detach from its diff. */
		.annotation-content {
			position: static;
			max-height: none;
			overflow: visible;
		}

		.diff-body {
			max-height: min(80vh, 720px);
		}
	}

</style>
