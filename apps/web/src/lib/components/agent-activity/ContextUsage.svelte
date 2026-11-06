<script lang="ts">
// Context-window gauge: a ring with the percent used, and on hover a card with
// the token breakdown.
import { LinkPreview } from "bits-ui";
import { untrack } from "svelte";
import Progress from "$lib/components/ui/progress/progress.svelte";
import { gsap, tokens as motion, prefersReducedMotion } from "$lib/motion";
import { cn } from "$lib/utils.js";
import { type ContextUsageBreakdown, formatPercent, formatTokens } from "./context-usage";

interface Props {
  usedTokens: number;
  maxTokens: number;
  usage?: ContextUsageBreakdown;
}

let { usedTokens, maxTokens, usage }: Props = $props();

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const ratio = $derived(maxTokens > 0 ? usedTokens / maxTokens : 0);
const clamped = $derived(Math.max(0, Math.min(1, ratio)));
const percentLabel = $derived(formatPercent(ratio));
const ringColor = $derived(
  clamped >= 0.9 ? "text-danger" : clamped >= 0.6 ? "text-warning" : "text-text-secondary",
);
const rows = $derived(
  [
    { label: "Input", tokens: usage?.inputTokens ?? 0 },
    { label: "Output", tokens: usage?.outputTokens ?? 0 },
    { label: "Cache read", tokens: usage?.cacheReadInputTokens ?? 0 },
    { label: "Cache write", tokens: usage?.cacheCreationInputTokens ?? 0 },
  ].filter((row) => row.tokens > 0),
);

const ringOffset = $derived(CIRCUMFERENCE * (1 - clamped));
const initialRingOffset = untrack(() => ringOffset);

let ringEl: SVGCircleElement;
$effect(() => {
  const strokeDashoffset = ringOffset;
  if (prefersReducedMotion()) {
    gsap.set(ringEl, { strokeDashoffset });
    return;
  }
  gsap.to(ringEl, {
    strokeDashoffset,
    duration: motion.smooth,
    ease: motion.easeOutExpo,
    overwrite: "auto",
  });
});
</script>

<LinkPreview.Root openDelay={120} closeDelay={120}>
	<LinkPreview.Trigger>
		{#snippet child({ props })}
			<div
				{...props}
				role="status"
				aria-label="Context usage {percentLabel}"
				class="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs tabular-nums text-text-muted transition-colors duration-snap hover:bg-bg-elevated hover:text-text-secondary"
			>
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
						bind:this={ringEl}
						cx="10"
						cy="10"
						r={RADIUS}
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-dasharray={CIRCUMFERENCE}
						stroke-dashoffset={initialRingOffset}
						style="transform: rotate(-90deg); transform-origin: center;"
					/>
				</svg>
				<span class="whitespace-nowrap">{percentLabel}</span>
			</div>
		{/snippet}
	</LinkPreview.Trigger>
	<LinkPreview.Portal>
		<LinkPreview.Content
			side="top"
			align="end"
			sideOffset={6}
			data-slot="context-content"
			data-glass
			class="text-text-primary z-50 w-64 origin-(--transform-origin) divide-y divide-border-subtle overflow-hidden rounded-xl p-0 text-sm outline-hidden"
		>
			<div class="flex w-full flex-col gap-2 p-3">
				<div class="flex items-center justify-between gap-3 text-xs">
					<span class="font-medium text-text-primary">{percentLabel}</span>
					<span class="font-mono text-text-muted">
						{formatTokens(usedTokens)} <span class="opacity-60">/</span>
						{formatTokens(maxTokens)}
					</span>
				</div>
				<Progress value={Math.round(clamped * 100)} class="h-1.5" />
			</div>
			<div class="flex w-full flex-col gap-1.5 p-3">
				{#each rows as row (row.label)}
					<div class="flex items-center justify-between gap-3 text-xs">
						<span class="text-text-muted">{row.label}</span>
						<span class="font-mono tabular-nums text-text-secondary">{formatTokens(row.tokens)}</span>
					</div>
				{/each}
			</div>
		</LinkPreview.Content>
	</LinkPreview.Portal>
</LinkPreview.Root>

<style>
	:global([data-slot='context-content']) {
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		box-shadow: var(--color-shadow-lg);
	}
</style>
