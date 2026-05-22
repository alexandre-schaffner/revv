<script lang="ts" module>
export interface AnimatedDigitProps {
  value: number;
  direction: 1 | -1;
}

const TRACK = Array.from({ length: 30 }, (_, index) => index % 10);

function normalize(value: number): number {
  return ((value % 10) + 10) % 10;
}

function spin(from: number, to: number, direction: 1 | -1): number {
  if (from === to) return 0;
  if (direction > 0) return (to - from + 10) % 10;
  return -((from - to + 10) % 10);
}
</script>

<script lang="ts">
import { untrack } from "svelte";

let { value, direction }: AnimatedDigitProps = $props();

let step = $state(untrack(() => value) + 10);
let last = untrack(() => value);
let ready = false;

$effect(() => {
  const nextValue = value;
  const nextDirection = direction;

  if (!ready) {
    ready = true;
    return;
  }

  const delta = spin(last, nextValue, nextDirection);
  last = nextValue;
  step = delta === 0 ? nextValue + 10 : step + delta;
});

function handleTransitionEnd(event: TransitionEvent): void {
  if (event.propertyName !== "transform") return;
  step = normalize(step) + 10;
}
</script>

<span data-slot="animated-number-digit">
  <span
    data-slot="animated-number-strip"
    style:--animated-number-offset={step}
    ontransitionend={handleTransitionEnd}
  >
    {#each TRACK as trackValue, index (index)}
      <span data-slot="animated-number-cell">{trackValue}</span>
    {/each}
  </span>
</span>

<style>
  [data-slot="animated-number-digit"] {
    display: inline-block;
    height: 1em;
    overflow: hidden;
    line-height: inherit;
    vertical-align: baseline;
  }

  [data-slot="animated-number-strip"] {
    display: flex;
    flex-direction: column;
    transform: translateY(calc(var(--animated-number-offset) * -1em));
    transition: transform var(--duration-smooth) var(--ease-out-expo);
    will-change: transform;
  }

  [data-slot="animated-number-cell"] {
    display: block;
    height: 1em;
    line-height: 1em;
  }
</style>
