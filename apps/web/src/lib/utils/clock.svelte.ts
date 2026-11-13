import { createSubscriber } from "svelte/reactivity";

const clocks = new Map<number, () => number>();

/**
 * The current time in ms, re-read every `granularityMs` while something
 * reactive is reading it. All readers of one granularity share one timer,
 * which stops when the last of them goes away.
 */
export function now(granularityMs: number): number {
  let clock = clocks.get(granularityMs);
  if (!clock) {
    clock = createClock(granularityMs);
    clocks.set(granularityMs, clock);
  }
  return clock();
}

function createClock(granularityMs: number): () => number {
  let current = Date.now();
  let ticking = false;
  const subscribe = createSubscriber((update) => {
    ticking = true;
    current = Date.now();
    const id = setInterval(() => {
      current = Date.now();
      update();
    }, granularityMs);
    return () => {
      ticking = false;
      clearInterval(id);
    };
  });
  return () => {
    subscribe();
    return ticking ? current : Date.now();
  };
}
