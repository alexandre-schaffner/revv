<script lang="ts">
import type { StackMergePlanLayer } from "@revv/shared";
import { gsapFade, tokens } from "$lib/motion";
import StackLayerGlyph from "./StackLayerGlyph.svelte";

// One layer of the merge sheet's "merge through" picker: a radio that picks
// how far up the stack to merge. The row's frame and type (`.layer-row`,
// `.layer-text`, …) are the sheet's, shared with the run's rows.

interface Props {
  layer: StackMergePlanLayer;
  /** Why this layer can't be the target; null when it can. */
  refusal: string | null;
  /** At or below the target: part of the merge. */
  inRange: boolean;
  isTarget: boolean;
  onpick: () => void;
}

let { layer, refusal, inRange, isTarget, onpick }: Props = $props();
</script>

<button
	type="button"
	role="radio"
	class="layer-row layer-pick"
	class:layer-pick--range={inRange && layer.readiness !== 'merged'}
	aria-checked={isTarget}
	disabled={refusal !== null}
	title={refusal ?? `Merge everything through #${layer.number}`}
	onclick={onpick}
>
	<span class="stack-layer-glyph" aria-hidden="true">
		<StackLayerGlyph status={layer.status} />
	</span>
	<span class="layer-text">
		<span class="layer-title">{layer.title}</span>
		<span class="layer-meta">
			#{layer.number}
			{#if layer.readiness === 'merged'}
				· Merged
			{:else if layer.readiness === 'blocked'}
				<span class="tone-warning">· {layer.reasons.join(' · ')}</span>
			{:else if layer.reasons.length > 0}
				· {layer.reasons.join(' · ')}
			{:else}
				· Ready
			{/if}
		</span>
	</span>
	{#if isTarget}
		<span class="layer-target" in:gsapFade={{ duration: tokens.snap }}>Through here</span>
	{/if}
</button>

<style>
	.layer-pick {
		background: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.layer-pick:hover:not(:disabled) {
		background: var(--color-tree-hover-bg);
	}

	.layer-pick:disabled {
		cursor: default;
	}

	.layer-pick--range {
		background: color-mix(in srgb, var(--color-success) 6%, transparent);
	}

	.layer-pick[aria-checked="true"] {
		border-color: color-mix(in srgb, var(--color-success) 40%, transparent);
	}

	.layer-pick:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	.layer-pick:disabled .layer-title {
		color: var(--color-text-secondary);
	}

	.layer-target {
		flex-shrink: 0;
		align-self: center;
		padding: 0 8px;
		border-radius: 999px;
		font-size: 0.6875rem;
		font-weight: 500;
		line-height: 18px;
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
	}
</style>
