<script lang="ts" module>
import type { Snippet } from "svelte";

export interface ToolActivityRevealProps {
  children: Snippet;
  class?: string;
}
</script>

<script lang="ts">
import { onMount, tick } from "svelte";
import { cn } from "$lib/utils.js";

let { children, class: className }: ToolActivityRevealProps = $props();

let width = $state("0px");
let ready = $state(false);
let auto = $state(false);
let ref: HTMLSpanElement | undefined;
let observer: ResizeObserver | undefined;

function measure(): void {
  const target = ref?.scrollWidth ?? 0;
  if (target <= 0) return;
  width = `${target}px`;
}

onMount(() => {
  void tick().then(() => {
    observer = ref ? new ResizeObserver(() => measure()) : undefined;
    if (ref) observer?.observe(ref);
    requestAnimationFrame(() => {
      measure();
      ready = true;
    });
  });

  return () => observer?.disconnect();
});

function handleTransitionEnd(event: TransitionEvent): void {
  if (event.propertyName !== "width") return;
  if (!ready) return;
  auto = true;
}
</script>

<span
  class={cn("tool-activity-reveal", className)}
  data-ready={ready ? "true" : "false"}
  style:width={auto ? "auto" : width}
  ontransitionend={handleTransitionEnd}
>
  <span class="tool-activity-reveal-inner" bind:this={ref}>
    {@render children()}
  </span>
</span>

<style>
  .tool-activity-reveal {
    display: inline-grid;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    vertical-align: baseline;
    transition: width var(--duration-smooth) var(--ease-out-expo);
  }

  .tool-activity-reveal-inner {
    width: max-content;
    min-width: 0;
    opacity: 0;
    filter: blur(2px);
    transform: translateX(-0.35rem);
    transition:
      opacity var(--duration-smooth) var(--ease-out-expo),
      filter var(--duration-smooth) var(--ease-out-expo),
      transform var(--duration-smooth) var(--ease-out-expo);
    white-space: nowrap;
    will-change: opacity, filter, transform;
  }

  .tool-activity-reveal[data-ready="true"] .tool-activity-reveal-inner {
    opacity: 1;
    filter: blur(0);
    transform: translateX(0);
  }
</style>
