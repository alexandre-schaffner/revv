<script lang="ts" module>
import { SvelteSet } from "svelte/reactivity";

/** Banners the reader closed, by PR and verdict, for this session only. */
const dismissed = new SvelteSet<string>();
</script>

<script lang="ts">
/*
 * One calm line at the top of a stacked PR's walkthrough when the stack moved
 * under its review: the server's restack verdict for this layer, in the
 * reader's terms, with the one action that answers it. Informational unless
 * the layer itself changed (review what's new) or can't merge (rebase).
 */

import type { RestackVerdict, StackLayer } from "@revv/shared";
import Checks from "phosphor-svelte/lib/Checks";
import GitDiff from "phosphor-svelte/lib/GitDiff";
import StackSimple from "phosphor-svelte/lib/StackSimple";
import Warning from "phosphor-svelte/lib/Warning";
import X from "phosphor-svelte/lib/X";
import { gsapFadeY } from "$lib/motion";
import { getStackRebase, rebaseStack } from "$lib/stores/stack-rebase.svelte";
import { getLayer, getStack } from "$lib/stores/stacks.svelte";
import { regenerate } from "$lib/stores/walkthrough.svelte";
import { openStackLayer } from "./open-layer";

interface Props {
  prId: string;
}

let { prId }: Props = $props();

type Banner =
  | { readonly kind: "below-moved"; readonly layer: StackLayer; readonly more: number }
  | { readonly kind: "carried" }
  | { readonly kind: "layer-changed"; readonly files: readonly string[] }
  | { readonly kind: "needs-rebase"; readonly merged: StackLayer | null; readonly base: string };

const stack = $derived(getStack(prId));
const layer = $derived(getLayer(prId));

/** The banner the verdict calls for, or null when the review still reads true. */
const banner = $derived.by((): Banner | null => {
  if (!stack || !layer) return null;
  const verdict: RestackVerdict = layer.restack;
  const below = stack.layers.filter((l) => l.position < layer.position);
  switch (verdict.kind) {
    case "below-moved": {
      // The nearest moved layer is the one this layer builds on most directly.
      const moved = below
        .filter((l) => verdict.layers.includes(l.number))
        .sort((a, b) => b.position - a.position);
      const nearest = moved[0];
      return nearest ? { kind: "below-moved", layer: nearest, more: moved.length - 1 } : null;
    }
    case "restacked":
      return { kind: "carried" };
    case "layer-changed":
      return verdict.files.length > 0 ? { kind: "layer-changed", files: verdict.files } : null;
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

/** What the reader closed: the same verdict on the same PR stays closed, a new one shows. */
const dismissKey = $derived.by(() => {
  if (!banner) return null;
  switch (banner.kind) {
    case "below-moved":
      return `${prId}:below-moved:${banner.layer.number}:${banner.layer.headSha ?? ""}`;
    case "layer-changed":
      return `${prId}:layer-changed:${layer?.headSha ?? ""}`;
    default:
      return `${prId}:${banner.kind}:${layer?.headSha ?? ""}`;
  }
});

const visible = $derived(banner !== null && dismissKey !== null && !dismissed.has(dismissKey));

let reviewing = $state(false);
const rebasing = $derived(stack ? getStackRebase(stack).status === "loading" : false);

async function reviewWhatsNew(): Promise<void> {
  if (reviewing) return;
  reviewing = true;
  try {
    await regenerate(prId, undefined, "incremental");
  } finally {
    reviewing = false;
  }
}

function dismiss(): void {
  if (dismissKey) dismissed.add(dismissKey);
}

function fileCount(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}
</script>

{#if visible && banner}
	<div
		class="banner banner--{banner.kind}"
		role={banner.kind === 'needs-rebase' ? 'alert' : 'status'}
		in:gsapFadeY={{ y: -4 }}
	>
		<span class="icon" aria-hidden="true">
			{#if banner.kind === 'below-moved'}
				<StackSimple size={14} />
			{:else if banner.kind === 'carried'}
				<Checks size={14} weight="bold" />
			{:else if banner.kind === 'layer-changed'}
				<GitDiff size={14} />
			{:else}
				<Warning size={14} weight="fill" />
			{/if}
		</span>

		<p class="message">
			{#if banner.kind === 'below-moved'}
				<span class="ref">#{banner.layer.number}</span>
				{#if banner.more > 0}
					and {banner.more} more {banner.more === 1 ? 'layer' : 'layers'} below changed after this review.
				{:else}
					below {banner.layer.status === 'merged' ? 'merged' : 'changed'} after this review.
				{/if}
			{:else if banner.kind === 'carried'}
				Restacked onto the updated layer below. The changes are identical, so the review carried over.
			{:else if banner.kind === 'layer-changed'}
				<span title={banner.files.slice(0, 12).join('\n')}>
					This layer changed in {fileCount(banner.files.length)} since the review.
				</span>
			{:else}
				{#if banner.merged}<span class="ref">#{banner.merged.number}</span> below merged.{:else}A layer below merged.{/if}
				This layer needs a rebase onto <code class="base-ref">{banner.base}</code> before it can merge.
			{/if}
		</p>

		{#if banner.kind === 'below-moved'}
			{@const target = banner.layer}
			<button type="button" class="action" onclick={() => openStackLayer(prId, target)}>
				See #{target.number}
			</button>
		{:else if banner.kind === 'layer-changed'}
			<button type="button" class="action" disabled={reviewing} onclick={reviewWhatsNew}>
				{reviewing ? 'Starting…' : "Review what's new"}
			</button>
		{:else if banner.kind === 'needs-rebase' && stack?.viewerCanPush}
			{@const current = stack}
			<button
				type="button"
				class="action"
				disabled={rebasing}
				title="Replay every open layer onto the one below it and force-push them together"
				onclick={() => void rebaseStack(prId, current)}
			>
				{rebasing ? 'Rebasing…' : 'Rebase stack'}
			</button>
		{/if}

		<button type="button" class="close" aria-label="Dismiss" title="Dismiss" onclick={dismiss}>
			<X size={12} weight="bold" aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	/* One line, tinted toward its tone, a hairline of the same hue. Calm by
	   default; only a rebase speaks in the warning colour. */
	.banner {
		--tone: var(--color-text-subtle);
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-height: 2.25rem;
		padding: 0.375rem 0.375rem 0.375rem 0.75rem;
		border: 1px solid color-mix(in srgb, var(--tone) 22%, var(--color-border-subtle));
		border-radius: var(--radius-card);
		background: color-mix(in srgb, var(--tone) 5%, var(--color-bg-primary));
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.banner--carried {
		--tone: var(--color-success);
	}

	.banner--layer-changed {
		--tone: var(--color-accent);
	}

	.banner--needs-rebase {
		--tone: var(--color-warning);
		color: var(--color-text-primary);
	}

	.icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--tone);
	}

	.banner--below-moved .icon {
		color: var(--color-text-subtle);
	}

	.message {
		flex: 1;
		min-width: 0;
		margin: 0;
	}

	.ref {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-primary);
	}

	.base-ref {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-primary);
	}

	.action {
		flex-shrink: 0;
		padding: 0.25rem 0.5rem;
		border: none;
		border-radius: 6px;
		background: transparent;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
		color: var(--color-accent);
		cursor: pointer;
		transition: background-color var(--duration-instant) var(--ease-soft);
	}

	.action:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	.action:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.close {
		display: inline-grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-instant) var(--ease-soft),
			color var(--duration-instant) var(--ease-soft);
	}

	.close:hover {
		background: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
		color: var(--color-text-primary);
	}

	.action:focus-visible,
	.close:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}
</style>
