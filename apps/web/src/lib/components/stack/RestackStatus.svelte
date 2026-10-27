<script lang="ts">
import type { RestackVerdict, StackLayer } from "@revv/shared";
import { openStackLayer } from "$lib/stacks/open-layer";
import { getStackRebase, rebaseStack } from "$lib/stores/stack-rebase.svelte";
import { getLayer, getStack } from "$lib/stores/stacks.svelte";
import { getWalkthroughUiState } from "$lib/stores/walkthrough.svelte";
import RebaseStackConfirm from "./RebaseStackConfirm.svelte";

interface Props {
  prId: string;
}

let { prId }: Props = $props();

type StackStatus =
  | { readonly kind: "below-moved"; readonly layer: StackLayer; readonly more: number }
  | { readonly kind: "carried" }
  | { readonly kind: "layer-changed"; readonly files: readonly string[] }
  | { readonly kind: "needs-rebase"; readonly merged: StackLayer | null; readonly base: string };

const stack = $derived(getStack(prId));
const layer = $derived(getLayer(prId));
// The verdict compares against the last *complete* review, so it still reads
// `layer-changed` while the review of the new head runs. Clicking again would
// cancel that run and start over.
const reviewRunning = $derived(
  layer?.review.kind === "generating" || getWalkthroughUiState().kind === "streaming",
);

const status = $derived.by((): StackStatus | null => {
  if (!stack || !layer) return null;
  const verdict: RestackVerdict = layer.restack;
  const below = stack.layers.filter((l) => l.position < layer.position);
  switch (verdict.kind) {
    case "below-moved": {
      const moved = below
        .filter((l) => verdict.layers.includes(l.number))
        .sort((a, b) => b.position - a.position);
      const nearest = moved[0];
      return nearest ? { kind: "below-moved", layer: nearest, more: moved.length - 1 } : null;
    }
    case "restacked":
      return { kind: "carried" };
    case "layer-changed":
      return verdict.files.length > 0 && !reviewRunning
        ? { kind: "layer-changed", files: verdict.files }
        : null;
    case "needs-rebase": {
      const merged = below
        .filter((l) => l.status === "merged")
        .sort((a, b) => b.position - a.position)[0];
      return { kind: "needs-rebase", merged: merged ?? null, base: stack.baseRefName };
    }
    case "current":
    case "unknown":
      return layer.review.kind === "complete" && layer.review.carried ? { kind: "carried" } : null;
  }
});

let confirmingRebase = $state(false);
const rebasing = $derived(stack ? getStackRebase(stack).status === "loading" : false);

function fileCount(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}
</script>

{#if status}
	<div class="restack-status">
		<p class="message" role="status">
			{#if status.kind === 'below-moved'}
				<span class="ref">#{status.layer.number}</span>
				{#if status.more > 0}
					and {status.more} more {status.more === 1 ? 'layer' : 'layers'} changed since this review.
				{:else}
					{status.layer.status === 'merged' ? 'merged' : 'changed'} since this review.
				{/if}
			{:else if status.kind === 'carried'}
				Review carried over after restacking.
			{:else if status.kind === 'layer-changed'}
				<span title={status.files.slice(0, 12).join('\n')}>
					{fileCount(status.files.length)} changed since this review.
				</span>
			{:else}
				{#if status.merged}<span class="ref">#{status.merged.number}</span> merged.{:else}A layer below merged.{/if}
				Rebase onto <code class="base-ref">{status.base}</code> to merge.
			{/if}
		</p>

		{#if status.kind === 'below-moved'}
			{@const target = status.layer}
			<button type="button" class="action" onclick={() => openStackLayer(prId, target)}>
				See #{target.number}
			</button>

		{:else if status.kind === 'needs-rebase' && stack?.viewerCanPush}
			{@const current = stack}
			<button
				type="button"
				class="action"
				disabled={rebasing}
				title="Replay every open layer onto the one below it and force-push them together"
				onclick={() => (confirmingRebase = true)}
			>
				{rebasing ? 'Rebasing…' : 'Rebase stack'}
			</button>
			<RebaseStackConfirm
				open={confirmingRebase}
				stack={current}
				onOpenChange={(open) => (confirmingRebase = open)}
				onConfirm={() => {
					confirmingRebase = false;
					void rebaseStack(prId, current);
				}}
			/>
		{/if}
	</div>
{/if}

<style>
	.restack-status {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: 0.75rem;
		row-gap: 0.25rem;
		min-width: 0;
		margin-top: 6px;
		font-size: 13px;
		line-height: 1.6;
		color: var(--color-text-secondary);
	}

	.message {
		min-width: 0;
		margin: 0;
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}

	.ref,
	.base-ref {
		font-family: var(--font-mono);
		font-size: inherit;
		color: var(--color-text-primary);
	}

	.action {
		flex-shrink: 0;
		padding: 0;
		border: none;
		border-radius: 2px;
		background: transparent;
		font: inherit;
		font-weight: 400;
		text-decoration: underline;
		text-decoration-color: var(--color-border);
		text-underline-offset: 3px;
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.action:hover:not(:disabled) {
		text-decoration-color: currentColor;
	}

	.action:disabled {
		color: var(--color-text-subtle);
		cursor: default;
		text-decoration: none;
	}

	.action:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 4px;
	}
</style>
