<script lang="ts">
// Every variant dispatches through `DOTMATRIX_VARIANTS` (./variants.ts). No
// local `<style>`: all CSS lives in `dotmatrix-loader.css`, imported globally
// via `app.css`, so the classes stay unhashed and match by name alone.

import { prefersReducedMotion } from "$lib/motion";
import {
  DOTMATRIX_VARIANTS,
  type DotmatrixVariant,
  type PerDotConfig,
  type VariantConfig,
} from "./variants";

interface Props {
  variant: DotmatrixVariant;
  size?: "default" | "small";
  active?: boolean;
}

let { variant, size = "default", active = true }: Props = $props();

const MATRIX_5X5 = (() =>
  Array.from({ length: 25 }, (_, i) => ({
    row: Math.floor(i / 5),
    col: i % 5,
  })))();

const reducedMotion = $derived(prefersReducedMotion());

const config: VariantConfig = $derived(DOTMATRIX_VARIANTS[variant]);
let stepIdx = $state(0);
let phase = $state(0);

// Reset sequencer state when variant changes to prevent out-of-bounds access
$effect(() => {
  variant; // track
  stepIdx = 0;
  phase = 0;
});

$effect(() => {
  const cfg = config;
  if (!active || reducedMotion) return;

  if (cfg.kind === "stepped") {
    const stepMs = cfg.cycleMs / cfg.stepCount;
    let s = 0;
    let id: ReturnType<typeof setTimeout> = setTimeout(function tick() {
      s = (s + 1) % cfg.stepCount;
      stepIdx = s;
      id = setTimeout(tick, stepMs);
    }, stepMs);
    return () => clearTimeout(id);
  }

  if (cfg.kind === "phase") {
    const start = performance.now();
    let rafId = 0;
    const tick = (now: number) => {
      const elapsed = (((now - start) % cfg.cycleMs) + cfg.cycleMs) % cfg.cycleMs;
      phase = elapsed / cfg.cycleMs;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }
});

function dotInlineStyle(idx: number, row: number, col: number): string {
  if (config.kind === "css") {
    const r = config.resolve(idx, row, col);
    if (r.inactive || !r.vars) return "";
    return Object.entries(r.vars)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
  }
  const op = reducedMotion
    ? config.idleOpacity(idx, row, col)
    : config.kind === "stepped"
      ? config.opacity(stepIdx, idx, row, col)
      : config.opacity(phase, idx, row, col);
  return `opacity: ${op};`;
}

function dotClass(idx: number, row: number, col: number): string {
  if (config.kind !== "css") return "dotmatrix-dot";
  const r: PerDotConfig = config.resolve(idx, row, col);
  if (r.inactive) return "dotmatrix-dot dotmatrix-dot--inactive";
  return r.className ? `dotmatrix-dot ${r.className}` : "dotmatrix-dot";
}
</script>

<span
	class="dotmatrix dotmatrix--{variant} dotmatrix--size-{size}"
	aria-hidden="true"
>
	{#each MATRIX_5X5 as dot, dotIdx (dotIdx)}
		<span class={dotClass(dotIdx, dot.row, dot.col)} style={dotInlineStyle(dotIdx, dot.row, dot.col)}></span>
	{/each}
</span>
