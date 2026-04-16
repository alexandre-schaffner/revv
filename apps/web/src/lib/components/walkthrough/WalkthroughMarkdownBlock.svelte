<script lang="ts">
	import { renderMarkdown } from '$lib/utils/markdown';

	interface Props {
		content: string;
		animateEntrance?: boolean;
	}

	let { content, animateEntrance = false }: Props = $props();

	const renderedContent = $derived(renderMarkdown(content));
</script>

<div class="markdown-block" class:animate={animateEntrance}>
	<div class="prose">
		{@html renderedContent}
	</div>
</div>

<style>
	.markdown-block.animate {
		animation: block-enter 0.3s ease-out;
	}

	.prose {
		font-size: 14px;
		line-height: 1.7;
		color: var(--rev-text-secondary);
	}

	.prose :global(h2) {
		font-size: 17px;
		font-weight: 600;
		color: var(--rev-text-primary);
		margin: 28px 0 12px;
		line-height: 1.3;
	}

	.prose :global(h2:first-child) {
		margin-top: 0;
	}

	.prose :global(h3) {
		font-size: 15px;
		font-weight: 600;
		color: var(--rev-text-primary);
		margin: 20px 0 8px;
		line-height: 1.3;
	}

	.prose :global(p) {
		margin: 0 0 12px;
	}

	.prose :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--rev-bg-tertiary);
		padding: 1px 5px;
		border-radius: 3px;
	}

	.prose :global(pre) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--rev-bg-tertiary);
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
		color: var(--rev-text-primary);
		font-weight: 600;
	}

	.prose :global(blockquote) {
		border-left: 3px solid var(--rev-accent);
		padding: 4px 12px;
		margin: 0 0 12px;
		color: var(--rev-text-secondary);
		background: color-mix(in srgb, var(--rev-accent) 5%, transparent);
		border-radius: 0 4px 4px 0;
	}

	.prose :global(hr) {
		border: none;
		border-top: 1px solid var(--rev-border-subtle);
		margin: 20px 0;
	}

	@keyframes block-enter {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
