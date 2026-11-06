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
import { gsap, prefersReducedMotion, tokens } from "$lib/motion";

let { value, direction }: AnimatedDigitProps = $props();

let strip: HTMLSpanElement;
// Index of the shown cell in the 30-cell track; a spin moves it up to 9 cells
// either way, then it settles back into the middle ten.
const initialStep = untrack(() => value) + 10;
let step = initialStep;
let last = untrack(() => value);

function show(next: number): void {
  step = next;
  gsap.set(strip, { "--animated-number-offset": step });
}

$effect(() => {
  const nextValue = value;
  const delta = spin(last, nextValue, direction);
  last = nextValue;
  if (delta === 0) return;
  if (prefersReducedMotion()) {
    show(nextValue + 10);
    return;
  }
  step += delta;
  gsap.to(strip, {
    "--animated-number-offset": step,
    duration: tokens.smooth,
    ease: tokens.easeOutExpo,
    overwrite: "auto",
    onComplete: () => show(normalize(step) + 10),
  });
});
</script>

<span data-slot="animated-number-digit">
  <span
    bind:this={strip}
    data-slot="animated-number-strip"
    style:--animated-number-offset={initialStep}
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
    will-change: transform;
  }

  [data-slot="animated-number-cell"] {
    display: block;
    height: 1em;
    line-height: 1em;
  }
</style>
