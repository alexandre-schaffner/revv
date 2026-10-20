<script lang="ts">
import type { PrStackDetail, StackEntryStatus, StackLayer } from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import { openStackLayer } from "$lib/components/stack/open-layer";
import StackLayerGlyph from "$lib/components/stack/StackLayerGlyph.svelte";
import { Button } from "$lib/components/ui/button";
import { getSelectedPr } from "$lib/stores/prs.svelte";
import { getStackRebase, rebaseNeed, rebaseStack } from "$lib/stores/stack-rebase.svelte";

// The stack this PR belongs to, top of the stack first and the base branch
// last, the way GitHub draws it: you read down toward what lands first.

interface Props {
  /** The stack store's read, which every layer of a stack shares. */
  stack: PrStackDetail;
  /** The PR on screen. */
  number: number;
}

let { stack, number }: Props = $props();

const STATUS_LABEL: Record<StackEntryStatus, string> = {
  merged: "Merged",
  closed: "Closed",
  draft: "Draft",
  ready: "Ready",
  not_ready: "Not ready",
};

const selectedId = $derived(getSelectedPr()?.id ?? null);
const entries = $derived(stack.layers);
const baseRefName = $derived(stack.baseRefName);
const topFirst = $derived([...entries].reverse());

// GitHub's merge box offers "Rebase stack" once the stack lost its linear
// history; so does this list, with the layer that lost it.
const need = $derived(rebaseNeed(stack));
const rebase = $derived(getStackRebase(stack));
const rebasing = $derived(rebase.status === "loading");

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

/** Open a stacked PR in Revv; one it doesn't hold yet comes through the deep-link resolver. */
function open(entry: StackLayer): void {
  if (!selectedId) return;
  openStackLayer(selectedId, entry);
}
</script>

<section class="stack" aria-labelledby="side-stack">
	<header class="stack-head">
		<h3 id="side-stack">Stack #{stack.number}</h3>
		<span class="stack-count">{entries.length} pull requests</span>
	</header>
	{#if need}
		<div class="stack-rebase" role="status">
			<span class="stack-rebase-text">{needText}</span>
			{#if stack.viewerCanPush && selectedId}
				{@const prId = selectedId}
				<Button
					variant="outline"
					size="xs"
					disabled={rebasing}
					onclick={() => void rebaseStack(prId, stack)}
					title="Replay every open layer onto the one below it, the bottom onto {baseRefName}, and force-push them together. Nothing is pushed if any layer conflicts or moved meanwhile."
				>
					<ArrowsClockwise size={12} weight="bold" class={rebasing ? 'motion-essential-spin' : ''} />
					{rebasing ? 'Rebasing…' : 'Rebase stack'}
				</Button>
			{/if}
		</div>
		{#if rebase.status === 'error'}
			<p class="stack-rebase-error">{rebase.error}</p>
		{/if}
	{/if}
	<ol class="stack-list">
		{#each topFirst as entry (entry.number)}
			{@const current = entry.number === number}
			<li class="stack-item">
				<button
					type="button"
					class="stack-entry"
					class:stack-entry--current={current}
					aria-current={current ? 'page' : undefined}
					disabled={current}
					onclick={() => open(entry)}
				>
					<span class="stack-glyph" aria-hidden="true">
						<StackLayerGlyph status={entry.status} />
					</span>
					<span class="stack-text">
						<span class="stack-title">{entry.title}</span>
						<span class="stack-meta">#{entry.number} · {entry.headRef}</span>
					</span>
					<span class="stack-status stack-status--{entry.status}">{STATUS_LABEL[entry.status]}</span>
				</button>
			</li>
		{/each}
		<li class="stack-item stack-base">
			<span class="stack-glyph stack-glyph--base" aria-hidden="true"></span>
			<code>{baseRefName}</code>
		</li>
	</ol>
</section>

<style>
	.stack-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		min-height: 24px;
		margin-bottom: 6px;
	}

	.stack-head h3 {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--color-text-secondary);
	}

	.stack-count {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.stack-rebase {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 6px;
		padding: 6px 8px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-warning) 10%, transparent);
	}

	.stack-rebase-text {
		min-width: 0;
		font-size: 0.75rem;
		color: var(--color-warning);
	}

	.stack-rebase-error {
		margin: 0 0 6px;
		padding: 0 8px;
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--color-danger);
	}

	.stack-list {
		position: relative;
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The spine the entries hang on, base at the bottom. */
	.stack-list::before {
		content: "";
		position: absolute;
		top: 16px;
		bottom: 10px;
		left: 14.5px;
		width: 1px;
		background: var(--color-border);
	}

	.stack-entry {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
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

	.stack-glyph {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 14px;
		height: 18px;
		background: var(--color-bg-primary);
		border-radius: 50%;
	}

	.stack-entry--current .stack-glyph,
	.stack-entry:hover:not(:disabled) .stack-glyph {
		background: transparent;
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
		font-size: 0.8125rem;
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
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.stack-status {
		flex-shrink: 0;
		padding: 0 6px;
		border-radius: 999px;
		font-size: 0.6875rem;
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

	.stack-base {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
	}

	.stack-glyph--base {
		width: 9px;
		height: 9px;
		margin: 0 2.5px;
		border: 1.5px solid var(--color-text-muted);
	}

	.stack-base code {
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}
</style>
