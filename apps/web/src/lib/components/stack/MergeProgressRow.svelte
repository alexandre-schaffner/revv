<script lang="ts">
import type { StackMergeLayerState, StackMergePlanLayer } from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import Circle from "phosphor-svelte/lib/Circle";
import CircleNotch from "phosphor-svelte/lib/CircleNotch";
import Clock from "phosphor-svelte/lib/Clock";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import XCircle from "phosphor-svelte/lib/XCircle";
import { Shimmer } from "$lib/components/ai/shimmer";
import { gsapFade, tokens } from "$lib/motion";
import StackLayerGlyph from "./StackLayerGlyph.svelte";

interface Props {
  layer: StackMergePlanLayer;
  /** The run's state for this layer; null when the run doesn't reach it. */
  progress: { readonly state: StackMergeLayerState; readonly message: string | null } | null;
  live: boolean;
  waiting: boolean;
  baseRefName: string;
}

let { layer, progress, live, waiting, baseRefName }: Props = $props();

function runLine(state: StackMergeLayerState, message: string | null): string {
  switch (state) {
    case "pending":
      return "Waiting its turn";
    case "retargeting":
      return `Pointing it at ${baseRefName}`;
    case "rebasing":
      return `Rebasing the stack onto ${baseRefName}`;
    case "merging":
      if (!waiting) return "Merging";
      return message ? `${message}, waiting for GitHub` : "Waiting for GitHub";
    case "auto_merge":
      return "GitHub auto-merge will finish it";
    case "merged":
      return "Merged";
    case "failed":
      return message ?? "Stopped here";
  }
}
</script>

<div class="layer-row" class:outside={!progress}>
	<span class="stack-layer-glyph" aria-hidden="true">
		{#if !progress}
			<StackLayerGlyph status={layer.status} />
		{:else if progress.state === 'merged'}
			<GitMerge size={14} weight="bold" class="tone-merged" />
		{:else if progress.state === 'failed'}
			<XCircle size={14} weight="fill" class="tone-danger" />
		{:else if progress.state === 'auto_merge'}
			<Clock size={14} weight="bold" class="tone-accent" />
		{:else if progress.state === 'retargeting'}
			<ArrowsClockwise size={14} weight="bold" class="tone-accent" />
		{:else if progress.state === 'merging' || progress.state === 'rebasing'}
			<CircleNotch size={14} weight="bold" class="tone-accent motion-essential-spin" />
		{:else}
			<Circle size={14} class="tone-muted" />
		{/if}
	</span>
	<span class="layer-text">
		<span class="layer-title">{layer.title}</span>
		<span class="layer-meta">
			#{layer.number}
			{#if progress}
				{#key progress.state}
					<span
						class="layer-state"
						class:tone-danger={progress.state === 'failed'}
						in:gsapFade={{ duration: tokens.quick }}
					>
						· <Shimmer
							active={live &&
								(progress.state === 'merging' ||
									progress.state === 'retargeting' ||
									progress.state === 'rebasing')}>{runLine(progress.state, progress.message)}</Shimmer
						>
					</span>
				{/key}
			{:else}
				· Not in this merge
			{/if}
		</span>
	</span>
</div>

<style>
	.outside {
		opacity: 0.55;
	}

	.layer-state {
		display: inline;
	}
</style>
