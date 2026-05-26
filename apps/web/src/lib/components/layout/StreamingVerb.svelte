<script lang="ts">
// ── Streaming verb ─────────────────────────────────────────────────────
// Rotates through a short list of present-progressive verbs while the
// assistant bubble is waiting for its first content token. Visually
// matches the walkthrough's tool-call labels (`GuidedWalkthrough.svelte`
// :687-697): same 14px row height, accent-colored "tool" text, fly-up
// in / fly-up out transition driven by a `{#key}` re-mount.
//
// Unlike the walkthrough — which animates *real* tool activity as it
// arrives — this list is purely placeholder rotation: we don't know
// what the agent is doing yet, so the verbs are generic.

import { gsapFadeY, tokens } from "$lib/motion";

const VERBS = [
  "Thinking",
  "Pondering",
  "Reading",
  "Cogitating",
  "Mulling",
  "Analyzing",
  "Noodling",
  "Examining",
  "Marinating",
  "Spelunking",
  "Inspecting",
  "Sleuthing",
  "Squinting",
  "Untangling",
  "Ruminating",
  "Brewing",
  "Tinkering",
  "Wrangling",
  "Reviewing",
  "Considering",
] as const;

const STEP_MS = 3000;
const ROW_H = 14;

// Shuffle on mount so each session sees the verbs in a different order
// (no repeats within a cycle, full variety eventually).
function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

const order = shuffled(VERBS);
let idx = $state(0);

$effect(() => {
  const id = setInterval(() => {
    idx = (idx + 1) % order.length;
  }, STEP_MS);
  return () => clearInterval(id);
});

const verb = $derived(order[idx % order.length]);
</script>

<div class="streaming-verb" aria-live="polite">
	{#key verb}
		<span
			class="streaming-verb-text"
			in:gsapFadeY={{ y: ROW_H, duration: tokens.smooth }}
			out:gsapFadeY={{ y: -ROW_H, duration: tokens.quick }}
		>
			{verb}…
		</span>
	{/key}
</div>

<style>
	.streaming-verb {
		position: relative;
		flex: 1;
		min-width: 0;
		height: 14px;
		overflow: hidden;
	}

	.streaming-verb-text {
		position: absolute;
		inset: 0 auto 0 0;
		display: inline-block;
		font-size: 11px;
		line-height: 14px;
		color: var(--color-accent);
		font-weight: 500;
		white-space: nowrap;
	}
</style>
