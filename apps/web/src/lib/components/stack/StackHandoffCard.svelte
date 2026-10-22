<script lang="ts">
import { isOpenLayer } from "@revv/shared";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import Check from "phosphor-svelte/lib/Check";
import { Shimmer } from "$lib/components/ai/shimmer";
import { Button } from "$lib/components/ui/button";
import { gsapFadeY } from "$lib/motion";
import { openStackLayer } from "$lib/stacks/open-layer";
import {
  layerFacts,
  layerRole,
  needsReview,
  REVIEW_VERDICT_LABEL,
  RISK_LABEL,
  readableBrief,
} from "$lib/stacks/stack-layer-facts";
import { getLayer, getNeighbour, getStack } from "$lib/stores/stacks.svelte";
import StackLayerGlyph from "./StackLayerGlyph.svelte";

interface Props {
  prId: string;
}

let { prId }: Props = $props();

const stack = $derived(getStack(prId));
const here = $derived(getLayer(prId));
const next = $derived(getNeighbour(prId, "up"));
const brief = $derived(readableBrief(stack?.brief ?? null));
const nextRole = $derived(next ? layerRole(next, brief) : null);
const nextFacts = $derived(next ? layerFacts(next) : []);

const atTop = $derived(stack !== null && here !== null && next === null);
const allReviewed = $derived(
  stack?.layers.filter(isOpenLayer).every((l) => l.review.kind === "complete" && !needsReview(l)) ??
    false,
);
const anyOpen = $derived(stack?.layers.some(isOpenLayer) ?? false);
</script>

{#if next}
	<section class="handoff" aria-labelledby="stack-handoff-{prId}" in:gsapFadeY={{ y: 6 }}>
		<p class="eyebrow" id="stack-handoff-{prId}">Next in stack</p>
		<div class="handoff-body">
			<span class="glyph"><StackLayerGlyph status={next.status} size={16} /></span>
			<div class="text">
				<p class="line">
					<span class="num">#{next.number}</span>
					<span class="title">{next.title}</span>
				</p>
				{#if next.review.kind === 'generating'}
					<p class="role"><Shimmer>Reviewing this layer…</Shimmer></p>
				{:else if nextRole}
					<p class="role">{nextRole}</p>
				{:else}
					<p class="role role--none">Not reviewed yet</p>
				{/if}
				{#if nextFacts.length > 0}
					<p class="facts">
						{#each nextFacts as fact (fact.key)}
							<span class="fact fact--{fact.tone}">
								{#if fact.kind === 'risk'}
									<span class="risk-dot risk-dot--{fact.risk}" aria-hidden="true"></span>
									{RISK_LABEL[fact.risk]}
								{:else if fact.kind === 'verdict'}
									{#if fact.verdict === 'approved'}
										<Check size={11} weight="bold" aria-hidden="true" />
									{/if}
									{REVIEW_VERDICT_LABEL[fact.verdict]}
								{:else}
									{fact.label}
								{/if}
							</span>
						{/each}
					</p>
				{/if}
			</div>
			<Button class="continue" onclick={() => openStackLayer(prId, next)}>
				<ArrowUp size={14} weight="bold" aria-hidden="true" />
				Continue to #{next.number}
				<kbd class="kbd" aria-label="Option Command Up Arrow">⌥⌘↑</kbd>
			</Button>
		</div>
	</section>
{:else if atTop && anyOpen && allReviewed}
	<section class="handoff handoff--end" aria-labelledby="stack-end-{prId}" in:gsapFadeY={{ y: 6 }}>
		<p class="eyebrow" id="stack-end-{prId}">End of stack</p>
		<div class="handoff-body">
			<p class="end-text">Every open layer has a review of its current head.</p>
		</div>
	</section>
{/if}

<style>
	.handoff {
		margin-top: 1.5rem;
		padding: 0.875rem 1rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-bg-primary);
	}

	.eyebrow {
		margin: 0 0 0.5rem;
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 12.5px;
		font-weight: 500;
		letter-spacing: 0.2px;
		color: var(--color-accent);
	}

	.handoff--end .eyebrow {
		color: var(--color-text-subtle);
	}

	.handoff-body {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.glyph {
		align-self: flex-start;
		display: grid;
		place-items: center;
		height: 1.375rem;
	}

	.text {
		display: flex;
		flex-direction: column;
		gap: 0.1875rem;
		flex: 1;
		min-width: 0;
	}

	.line {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
		margin: 0;
	}

	.num {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-subtle);
	}

	.title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.9375rem;
		font-weight: 600;
		line-height: 1.375rem;
		color: var(--color-text-primary);
	}

	.role {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.role--none {
		color: var(--color-text-subtle);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		margin: 0.125rem 0 0;
		font-size: 0.6875rem;
		font-variant-numeric: tabular-nums;
	}

	.fact {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--color-text-subtle);
	}

	.fact--success {
		color: var(--color-success);
	}

	.fact--warning {
		color: var(--color-warning);
	}

	.fact--danger {
		color: var(--color-danger);
	}

	.fact--accent {
		color: var(--color-accent);
	}

	.risk-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.risk-dot--low {
		background: var(--color-success);
	}

	.risk-dot--medium {
		background: var(--color-warning);
	}

	.risk-dot--high {
		background: var(--color-danger);
	}

	.handoff-body > :global(.continue) {
		flex-shrink: 0;
		align-self: center;
	}

	.kbd {
		margin-left: 0.25rem;
		padding: 0 0.3125rem;
		border-radius: 4px;
		background: color-mix(in srgb, currentColor 16%, transparent);
		font-family: var(--font-sans);
		font-size: 0.6875rem;
		font-weight: 500;
		line-height: 1.125rem;
		letter-spacing: 0.04em;
		opacity: 0.85;
	}

	.end-text {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	@container (max-width: 640px) {
		.handoff-body {
			flex-wrap: wrap;
		}

		.handoff-body > :global(.continue) {
			margin-left: calc(16px + 0.75rem);
		}
	}
</style>
