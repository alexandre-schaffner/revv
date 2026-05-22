<script lang="ts" module>
import type { Snippet } from "svelte";

export type ContextTriggerProps = {
  class?: string;
  /** Override the default trigger content (ring + percent). */
  children?: Snippet;
};
</script>

<script lang="ts">
	import { LinkPreview } from 'bits-ui';
	import { cn } from '$lib/utils.js';
	import { getContextState, formatPercent } from './context-shared.js';

	const RADIUS = 8;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

	let { class: className, children }: ContextTriggerProps = $props();

	const state = getContextState();
	const ratio = $derived(
		state().maxTokens > 0 ? state().usedTokens / state().maxTokens : 0,
	);
	const clamped = $derived(Math.max(0, Math.min(1, ratio)));
	const dashOffset = $derived(CIRCUMFERENCE * (1 - clamped));
	const percentLabel = $derived(formatPercent(ratio));
	const ringColor = $derived(
		clamped >= 0.9
			? 'text-danger'
			: clamped >= 0.6
				? 'text-warning'
				: 'text-text-secondary',
	);
</script>

<LinkPreview.Trigger>
	{#snippet child({ props })}
		<div
			{...props}
			role="status"
			aria-label="Context usage {percentLabel}"
			class={cn(
				'flex items-center gap-1.5 rounded px-1 py-0.5 text-xs tabular-nums text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-secondary',
				className,
			)}
		>
			{#if children}
				{@render children()}
			{:else}
				<svg
					width="12"
					height="12"
					viewBox="0 0 20 20"
					class={cn('shrink-0', ringColor)}
					aria-hidden="true"
				>
					<circle
						cx="10"
						cy="10"
						r={RADIUS}
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						opacity="0.25"
					/>
					<circle
						cx="10"
						cy="10"
						r={RADIUS}
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-dasharray={CIRCUMFERENCE}
						stroke-dashoffset={dashOffset}
						style="transform: rotate(-90deg); transform-origin: center; transition: stroke-dashoffset var(--duration-smooth) var(--ease-out-expo);"
					/>
				</svg>
				<span class="whitespace-nowrap">{percentLabel}</span>
			{/if}
		</div>
	{/snippet}
</LinkPreview.Trigger>
