<script lang="ts">
// Placeholder verbs rotated while the assistant bubble waits for its first
// token: we don't know what the agent is doing yet.

import ToolCallTicker from "$lib/components/agent-activity/ToolCallTicker.svelte";

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
	<ToolCallTicker rows={[{ key: idx, label: `${verb}…` }]} lines={1} />
</div>

<style>
	.streaming-verb {
		display: flex;
		flex: 1;
		min-width: 0;
		font-size: 11px;
	}
</style>
