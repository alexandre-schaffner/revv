<script lang="ts">
// Placeholder verbs rotated while the assistant bubble waits for its first
// token: we don't know what the agent is doing yet. Rows match the
// walkthrough's tool-call labels (14px, accent text, fly-up).

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

function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const ai = a[i];
    const aj = a[j];
    if (ai !== undefined && aj !== undefined) {
      a[i] = aj;
      a[j] = ai;
    }
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
