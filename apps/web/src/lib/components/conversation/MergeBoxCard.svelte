<script lang="ts">
import type { Snippet } from "svelte";

// A card of GitHub's merge box: a round mark, a one-line headline with its
// detail, actions on the right, and whatever the card lists below.

interface Props {
  label: string;
  title: string;
  detail: string;
  /** The mark's colour, for glyphs that don't colour themselves. */
  markTone?: "muted" | "warning" | "success" | null;
  mark: Snippet;
  actions?: Snippet;
  children?: Snippet;
}

let { label, title, detail, markTone = null, mark, actions, children }: Props = $props();
</script>

<section class="card" aria-label={label}>
	<header class="head">
		<span class="mark mark--{markTone ?? 'own'}" aria-hidden="true">{@render mark()}</span>
		<div class="text">
			<h2 class="title">{title}</h2>
			<p class="detail">{detail}</p>
		</div>
		<div class="actions">{@render actions?.()}</div>
	</header>
	{@render children?.()}
</section>

<style>
	.card {
		overflow: clip;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-bg-primary);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 12px 12px 14px;
	}

	.mark {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--color-bg-secondary);
	}

	.mark--muted {
		color: var(--color-text-secondary);
	}

	.mark--warning {
		color: var(--color-warning);
	}

	.mark--success {
		color: var(--color-success);
	}

	.text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		min-width: 0;
	}

	.title {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 600;
		line-height: 1.35;
		color: var(--color-text-primary);
	}

	.detail {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}
</style>
