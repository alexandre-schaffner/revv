<script lang="ts">
/*
 * A note in the walkthrough's margin about the rest of the stack, beside the
 * content it concerns. Deliberately not the agent's annotation card: no box,
 * a smaller voice, a hairline over it that continues the section rule, so
 * the reader can tell the agent's remarks on this diff from the stack's
 * remarks on its neighbours.
 *
 * In the narrow layout (no rail) the same note reads inline, under the thing
 * it annotates: the hairline becomes a short rule at the start of a line.
 */
import type { Component, Snippet } from "svelte";

interface Props {
  icon: Component<{ size?: number; weight?: "regular" | "bold" | "fill" }>;
  label: string;
  /** Right of the label, e.g. the layer's place. */
  aside?: string | undefined;
  children: Snippet;
  foot?: Snippet | undefined;
}

let { icon: Icon, label, aside, children, foot }: Props = $props();
</script>

<aside class="note" data-margin-note aria-label={label}>
	<div class="label">
		<Icon size={13} weight="bold" />
		<span>{label}</span>
		{#if aside}<span class="aside">{aside}</span>{/if}
	</div>
	<div class="body">{@render children()}</div>
	{#if foot}
		<div class="foot">{@render foot()}</div>
	{/if}
</aside>

<style>
	.note {
		position: relative;
		padding-top: 13px;
		border-top: 1px solid var(--color-border);
		text-align: left;
	}

	.label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		line-height: 16px;
		color: var(--color-text-secondary);
	}

	.label :global(svg) {
		flex-shrink: 0;
		color: var(--color-text-subtle);
	}

	.aside {
		margin-left: auto;
		font-weight: 400;
		color: var(--color-text-subtle);
		font-variant-numeric: tabular-nums;
	}

	.body {
		margin-top: 6px;
		font-size: 13px;
		line-height: 1.65;
		color: var(--color-text-secondary);
		text-wrap: pretty;
	}

	.body :global(p) {
		margin: 0;
	}

	.body :global(p + p) {
		margin-top: 6px;
	}

	.body :global(strong) {
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.body :global(code) {
		font-family: var(--font-mono);
		font-size: 0.88em;
		color: var(--color-text-primary);
	}

	.foot {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--color-border-subtle);
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-subtle);
	}

	:global(.dark) .foot {
		border-top-color: var(--color-border);
	}

	/* No rail: the note reads inline under what it annotates, as one quiet
	   run of text led by its label. The hairline shortens to a tick so it
	   still reads as the same kind of thing as the rail's notes. */
	@container (max-width: 1335px) {
		.note {
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			column-gap: 8px;
			padding: 0 0 0 14px;
			border-top: 0;
		}

		.note::before {
			content: "";
			position: absolute;
			top: 0.62em;
			left: 0;
			width: 8px;
			border-top: 1px solid var(--color-border);
		}

		.label {
			font-size: 12px;
			line-height: 1.6;
		}

		.label :global(svg) {
			display: none;
		}

		.aside {
			display: none;
		}

		.body {
			flex: 1 1 0;
			min-width: 16rem;
			margin-top: 0;
			font-size: 12.5px;
			line-height: 1.6;
		}

		.body :global(p + p) {
			margin-top: 2px;
		}
	}
</style>
