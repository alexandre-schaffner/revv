<script lang="ts">
	import { renderMarkdown } from '$lib/utils/markdown';
	import { isHighlighterReady } from '$lib/utils/code-highlight.svelte';

	interface Props {
		content: string;
	}

	let { content }: Props = $props();

	// Re-derive when highlighter becomes ready so code blocks get highlighted
	const highlighterReady = $derived(isHighlighterReady());
	const renderedContent = $derived.by(() => {
		void highlighterReady;
		return renderMarkdown(content);
	});
</script>

<div class="markdown-block">
	<div class="prose">
		{@html renderedContent}
	</div>
</div>

<style>
	.prose {
		font-size: 14px;
		line-height: 1.7;
		color: var(--color-text-secondary);
	}

	.prose :global(h2) {
		font-size: 17px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 28px 0 12px;
		line-height: 1.3;
	}

	.prose :global(h2:first-child) {
		margin-top: 0;
	}

	.prose :global(h3) {
		font-size: 15px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 20px 0 8px;
		line-height: 1.3;
	}

	.prose :global(p) {
		margin: 0 0 12px;
	}

	.prose :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--color-bg-tertiary);
		padding: 1px 5px;
		border-radius: 3px;
	}

	.prose :global(pre) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--color-bg-tertiary);
		padding: 12px 14px;
		border-radius: 6px;
		overflow-x: auto;
		margin: 0 0 12px;
		line-height: 1.5;
	}

	.prose :global(pre code) {
		background: none;
		padding: 0;
	}

	.prose :global(ul),
	.prose :global(ol) {
		margin: 0 0 12px;
		padding-left: 20px;
	}

	.prose :global(li) {
		margin-bottom: 4px;
	}

	.prose :global(strong) {
		color: var(--color-text-primary);
		font-weight: 600;
	}

	.prose :global(blockquote) {
		border-left: 3px solid var(--color-accent);
		padding: 4px 12px;
		margin: 0 0 12px;
		color: var(--color-text-secondary);
		background: color-mix(in srgb, var(--color-accent) 5%, transparent);
		border-radius: 0 4px 4px 0;
	}

	.prose :global(hr) {
		border: none;
		border-top: 1px solid var(--color-border-subtle);
		margin: 20px 0;
	}

	/* ── Shiki syntax highlighting layout ──────────────────────────────
	   Dark/light color swap is handled globally in app.css.
	   ─────────────────────────────────────────────────────────────────── */

	.prose :global(.shiki) {
		font-family: var(--font-mono);
		font-size: 12px;
		padding: 12px 14px;
		border-radius: 6px;
		overflow-x: auto;
		margin: 0 0 12px;
		line-height: 1.5;
	}

	.prose :global(.shiki code) {
		background: none;
		padding: 0;
		font-size: inherit;
	}
</style>
