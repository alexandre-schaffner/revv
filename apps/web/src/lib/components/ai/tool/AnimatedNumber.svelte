<script lang="ts" module>
export interface AnimatedNumberProps {
  value: number;
  class?: string;
}
</script>

<script lang="ts">
import { untrack } from "svelte";
import AnimatedDigit from "./AnimatedDigit.svelte";
import { cn } from "$lib/utils.js";

let { value, class: className }: AnimatedNumberProps = $props();

const target = $derived(Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
let shown = $state(untrack(() => target));
let direction = $state<1 | -1>(1);

$effect(() => {
  if (target === shown) return;
  direction = target > shown ? 1 : -1;
  shown = target;
});

const label = $derived(String(shown));
const digits = $derived(
  Array.from(label, (char) => {
    const digit = char.charCodeAt(0) - 48;
    return digit >= 0 && digit <= 9 ? digit : 0;
  }).reverse(),
);
const width = $derived(`${digits.length}ch`);
</script>

<span data-component="animated-number" class={cn(className)} aria-label={label}>
  <span data-slot="animated-number-value" style:--animated-number-width={width}>
    {#each digits as digit, index (index)}
      <AnimatedDigit value={digit} {direction} />
    {/each}
  </span>
</span>

<style>
  [data-component="animated-number"] {
    display: inline-flex;
    align-items: baseline;
    font: inherit;
    font-variant-numeric: tabular-nums;
    line-height: inherit;
  }

  [data-slot="animated-number-value"] {
    display: inline-flex;
    width: var(--animated-number-width);
    align-items: baseline;
    flex-direction: row-reverse;
    justify-content: flex-end;
    line-height: inherit;
    transition: width var(--duration-smooth) var(--ease-out-expo);
  }
</style>
