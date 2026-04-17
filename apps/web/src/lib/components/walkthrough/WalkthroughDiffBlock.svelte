<script lang="ts">
	import type { DiffBlock } from '@revv/shared';
	import { FileDiff, parsePatchFiles, type FileDiffOptions } from '@pierre/diffs';
	import { workerManager } from '$lib/utils/worker-pool';
	import { renderMarkdown } from '$lib/utils/markdown';

	interface Props {
		block: DiffBlock;
		themeType: 'light' | 'dark' | 'system';
	}

	let { block, themeType }: Props = $props();

	const renderedAnnotation = $derived(
		block.annotation ? renderMarkdown(block.annotation) : null
	);

	function mountDiffBlock(el: HTMLDivElement) {
		const options: FileDiffOptions<never> = {
			diffStyle: 'unified',
			theme: { dark: 'pierre-dark', light: 'pierre-light' },
			themeType,
			overflow: 'scroll',
		};

		const instance = new FileDiff<never>(options, workerManager);

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
				instance.cleanUp();
			},
		};
	}
</script>

<div class="annotated-block" class:annotated-block--no-annotation={!block.annotation}>
	{#if block.annotation && block.annotationPosition === 'left'}
		<div class="annotation annotation--left">
			<div class="annotation-content">
				{@html renderedAnnotation}
			</div>
		</div>
	{/if}

	<div class="diff-panel">
		<div class="diff-header">
			<span class="diff-file-path">{block.filePath}</span>
		</div>
		<div class="diff-body" use:mountDiffBlock></div>
	</div>

	{#if block.annotation && block.annotationPosition === 'right'}
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
		overflow: hidden;
		container-type: inline-size;
	}

	.annotated-block--no-annotation {
		grid-template-columns: 1fr;
	}

	.annotation {
		display: flex;
		align-items: center;
		padding: 16px 20px;
		background: var(--revv-bg-secondary);
		font-size: 13px;
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
	}

	.annotation-content :global(p) {
		margin: 0 0 8px;
	}

	.annotation-content :global(p:last-child) {
		margin-bottom: 0;
	}

	.annotation-content :global(code) {
		font-family: var(--font-mono);
		font-size: 11px;
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
		background: var(--revv-diff-bg);
		border-bottom: 1px solid var(--revv-diff-gutter-border);
		padding: 6px 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--revv-text-muted);
	}

	.diff-file-path {
		font-weight: 500;
		color: var(--revv-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-body {
		overflow: hidden;
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
	}

</style>
