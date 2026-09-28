<script lang="ts">
import type { Snippet } from "svelte";

// An inset grouped list (the System Settings idiom): a warm-paper card on the
// stone pane, rows split by hairlines. One level only. A group never holds
// another group, so a pane is only ever pane → group → row.

interface Props {
  heading?: string;
  description?: string;
  /** Trailing header content, e.g. a count or an icon button. */
  actions?: Snippet;
  tone?: "default" | "danger";
  children: Snippet;
}

let { heading, description, actions, tone = "default", children }: Props = $props();
</script>

<section class="group" aria-label={heading}>
	{#if heading || actions}
		<header class="group-head">
			{#if heading}
				<h3 class="group-heading" class:group-heading--danger={tone === 'danger'}>{heading}</h3>
			{/if}
			{#if actions}
				<div class="group-actions">{@render actions()}</div>
			{/if}
		</header>
	{/if}
	{#if description}
		<p class="group-description">{description}</p>
	{/if}
	<div class="group-list" class:group-list--danger={tone === 'danger'}>
		{@render children()}
	</div>
</section>

<style>
	.group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.group-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 24px;
		padding: 0 4px;
	}

	.group-heading {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.group-heading--danger {
		color: var(--color-danger);
	}

	.group-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.group-description {
		max-width: 64ch;
		padding: 0 4px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.group-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--color-border-subtle);
		border-radius: 10px;
		background: var(--color-bg-primary);
		overflow: hidden;
	}

	/* Dark's surface stack runs the other way (primary is the deepest), so the
	   card steps up to tertiary to stay lighter than the pane. Dark's subtle
	   border *is* tertiary, so the card's edges and hairlines use the full one. */
	:global(.dark) .group-list {
		border-color: var(--color-border);
		background: var(--color-bg-tertiary);
	}

	:global(.dark) .group-list > :global(* + *) {
		border-top-color: var(--color-border);
	}

	.group-list--danger {
		border-color: color-mix(in srgb, var(--color-danger) 28%, var(--color-border-subtle));
	}

	.group-list > :global(* + *) {
		border-top: 1px solid var(--color-border-subtle);
	}
</style>
