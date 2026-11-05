<script lang="ts">
import type { PrStackDetail, StackLayer } from "@revv/shared";
import { openStackLayer } from "$lib/stacks/open-layer";
import { LAYER_STATUS_LABEL } from "$lib/stacks/stack-layer-facts";
import { getStackRebase, rebaseNeed } from "$lib/stores/stack-rebase.svelte";
import { getLayer } from "$lib/stores/stacks.svelte";
import RebaseStackAction from "./RebaseStackAction.svelte";
import SpineGlyph from "./SpineGlyph.svelte";
import StackLayerGlyph from "./StackLayerGlyph.svelte";
import StackLayerList from "./StackLayerList.svelte";

// The stack a PR belongs to, top of the stack first and the base branch
// last, the way GitHub draws it: you read down toward what lands first.

interface Props {
  prId: string;
  stack: PrStackDetail;
}

let { prId, stack }: Props = $props();

const here = $derived(getLayer(prId)?.number ?? null);
const topFirst = $derived([...stack.layers].reverse());
const need = $derived(rebaseNeed(stack));
const rebase = $derived(getStackRebase(stack));

const needText = $derived.by(() => {
  if (!need) return "";
  const n = `#${need.layer.number}`;
  switch (need.kind) {
    case "behind":
      return need.by === null
        ? `${n} is behind ${need.layer.baseRef}`
        : `${n} is ${need.by} ${need.by === 1 ? "commit" : "commits"} behind ${need.layer.baseRef}`;
    case "conflicts":
      return `${n} conflicts with ${need.layer.baseRef}`;
    case "merged-below":
      return `${n} still sits on a merged layer`;
  }
});

function open(layer: StackLayer): void {
  openStackLayer(prId, layer);
}
</script>

{#if need}
	<div class="stack-rebase" role="status">
		<span class="stack-rebase-text">{needText}</span>
		<RebaseStackAction {prId} {stack}>
			{#snippet trigger({ rebasing, title, onclick })}
				<button type="button" class="stack-rebase-action" disabled={rebasing} {onclick} {title}>
					{rebasing ? 'Rebasing…' : 'Rebase stack'}
				</button>
			{/snippet}
		</RebaseStackAction>
	</div>
	{#if rebase.status === 'error'}
		<p class="stack-rebase-error">{rebase.error}</p>
	{/if}
{/if}
<StackLayerList layers={topFirst} baseRefName={stack.baseRefName} --stack-spine-bottom="10px">
	{#snippet row(layer)}
		{@const current = layer.number === here}
		<button
			type="button"
			class="stack-entry"
			class:stack-entry--current={current}
			aria-current={current ? 'page' : undefined}
			disabled={current}
			onclick={() => open(layer)}
		>
			<SpineGlyph><StackLayerGlyph status={layer.status} /></SpineGlyph>
			<span class="stack-text">
				<span class="stack-title">{layer.title}</span>
				<span class="stack-meta">#{layer.number} · {layer.headRef}</span>
			</span>
			<span class="stack-status stack-status--{layer.status}">{LAYER_STATUS_LABEL[layer.status]}</span>
		</button>
	{/snippet}
</StackLayerList>

<style>
	.stack-rebase {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 12px;
		margin-bottom: 8px;
		font-size: var(--text-sm);
		line-height: 1.6;
	}

	.stack-rebase-text {
		min-width: 0;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	.stack-rebase-action {
		flex-shrink: 0;
		padding: 0;
		border: none;
		border-radius: 2px;
		background: transparent;
		font: inherit;
		font-weight: 400;
		color: var(--color-text-primary);
		text-decoration: underline;
		text-decoration-color: var(--color-border);
		text-underline-offset: 3px;
		cursor: pointer;
	}

	.stack-rebase-action:hover:not(:disabled) {
		text-decoration-color: currentColor;
	}

	.stack-rebase-action:disabled {
		color: var(--color-text-subtle);
		text-decoration: none;
		cursor: default;
	}

	.stack-rebase-action:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 4px;
	}

	.stack-rebase-error {
		margin: 0 0 6px;
		padding: 0 8px;
		font-size: var(--text-ui);
		line-height: 1.4;
		color: var(--color-danger);
	}

	.stack-entry {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 6px var(--stack-row-inset);
		border: none;
		border-radius: 6px;
		background: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.stack-entry:hover:not(:disabled) {
		background: var(--color-tree-hover-bg);
	}

	.stack-entry:disabled {
		cursor: default;
	}

	.stack-entry--current {
		background: var(--color-tree-active-bg);
	}

	/* The row's own background carries the glyph; the spine shows through. */
	.stack-entry--current,
	.stack-entry:hover:not(:disabled) {
		--spine-knockout: transparent;
	}

	.stack-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		min-width: 0;
	}

	.stack-title {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: var(--text-sm);
		font-weight: 500;
		line-height: 1.35;
		color: var(--color-text-primary);
	}

	.stack-entry--current .stack-title {
		color: var(--color-tree-active-text);
	}

	.stack-meta {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: var(--text-ui);
		color: var(--color-text-muted);
	}

	.stack-status {
		flex-shrink: 0;
		padding: 0 6px;
		border-radius: 999px;
		font-size: var(--text-ui);
		letter-spacing: var(--text-ui--letter-spacing);
		font-weight: 500;
		line-height: 18px;
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
	}

	.stack-status--merged {
		color: var(--color-merged);
		background: color-mix(in srgb, var(--color-merged) 12%, transparent);
	}

	.stack-status--ready {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
	}

	.stack-status--not_ready {
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
	}

	.stack-status--closed {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
	}
</style>
