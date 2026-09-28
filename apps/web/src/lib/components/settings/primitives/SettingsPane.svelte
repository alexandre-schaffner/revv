<script lang="ts">
import { Dialog as DialogPrimitive } from "bits-ui";
import X from "phosphor-svelte/lib/X";
import type { Snippet } from "svelte";
import { Button } from "$lib/components/ui/button/index.js";

interface Props {
  title: string;
  description: string;
  children: Snippet;
}

let { title, description, children }: Props = $props();
</script>

<!-- Sticky inside the pane scroller, so the close button can never scroll away. -->
<header class="pane-head">
	<div class="pane-head-text">
		<h2 class="pane-title">{title}</h2>
		<p class="pane-description">{description}</p>
	</div>
	<DialogPrimitive.Close>
		{#snippet child({ props })}
			<Button variant="ghost" size="icon-sm" aria-label="Close settings" {...props}>
				<X size={14} />
			</Button>
		{/snippet}
	</DialogPrimitive.Close>
</header>

<div class="pane-body">
	{@render children()}
</div>

<style>
	.pane-head {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 26px 20px 16px 36px;
		background: var(--color-bg-secondary);
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.pane-head-text {
		min-width: 0;
		padding-top: 2px;
	}

	.pane-title {
		font-family: "Newsreader", Georgia, serif;
		font-size: 22px;
		font-weight: 500;
		letter-spacing: -0.015em;
		line-height: 1.1;
		color: var(--color-text-primary);
	}

	.pane-description {
		margin-top: 6px;
		max-width: 64ch;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.pane-body {
		display: flex;
		flex-direction: column;
		gap: 24px;
		padding: 24px 36px 40px;
	}
</style>
