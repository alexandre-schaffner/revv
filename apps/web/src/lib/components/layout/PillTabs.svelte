<script lang="ts">
import type { Snippet } from "svelte";
import { gsap, prefersReducedMotion, tokens } from "$lib/motion";

export type TabConfig = { id: string; label: string; shortcut?: string };

interface Props {
  tabs: TabConfig[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  trailing?: Snippet;
  cmdHeld?: boolean;
}

let { tabs, activeTab, onTabChange, trailing, cmdHeld = false }: Props = $props();

let pillEl: HTMLDivElement | null = $state(null);
let indicatorEl: HTMLSpanElement | null = $state(null);
let segmentEls = $state<(HTMLButtonElement | null)[]>([]);
let hoveredIndex = $state<number | null>(null);
let hasMeasured = $state(false);

$effect(() => {
  // Keep segment refs array length in sync with tabs prop.
  if (segmentEls.length !== tabs.length) {
    segmentEls = tabs.map((_, i) => segmentEls[i] ?? null);
  }
});

// Indicator position is driven imperatively via GSAP rather than via reactive
// inline styles + a CSS `transition:`. The first measure jumps (gsap.set),
// subsequent measures tween — keeps GSAP as the single source of truth for
// timing across rapid tab switches (overwrite:auto cancels in-flight tweens).
$effect(() => {
  const activeIndex = tabs.findIndex((t) => t.id === activeTab);
  const index = hoveredIndex ?? activeIndex;
  const el = segmentEls[index];
  if (!el || !indicatorEl) return;

  const measure = () => {
    const seg = el;
    if (!pillEl || !seg || !indicatorEl) return;
    const pillRect = pillEl.getBoundingClientRect();
    const segRect = seg.getBoundingClientRect();
    const borderLeft = parseFloat(getComputedStyle(pillEl).borderLeftWidth) || 0;
    const rawLeft = segRect.left - pillRect.left - borderLeft;
    const left = Math.round(rawLeft);
    const width = Math.round(segRect.width);

    if (!hasMeasured || prefersReducedMotion()) {
      gsap.set(indicatorEl, { x: left, width, autoAlpha: 1 });
      hasMeasured = true;
    } else {
      gsap.to(indicatorEl, {
        x: left,
        width,
        duration: tokens.smooth,
        ease: tokens.easeOutExpo,
        overwrite: "auto",
      });
    }
  };

  measure();

  const observer = new ResizeObserver(measure);
  for (const s of segmentEls) {
    if (s) observer.observe(s);
  }
  if (pillEl) observer.observe(pillEl);
  return () => observer.disconnect();
});

function isDividerHidden(index: number): boolean {
  const activeIndex = tabs.findIndex((t) => t.id === activeTab);
  const highlighted = hoveredIndex ?? activeIndex;
  return index === highlighted || index + 1 === highlighted;
}

// Cmd-hold shortcut hint reveal. Animates the ⌘N labels next to each tab
// label when the user holds Cmd. CSS would have to tween opacity + max-width
// + margin together, which is awkward; one tween with stagger is clearer
// and lets us share `tokens.stagger.tight` for the per-segment offset.
$effect(() => {
  if (!pillEl) return;
  const hints = pillEl.querySelectorAll<HTMLElement>(".seg-shortcut");
  if (hints.length === 0) return;
  if (prefersReducedMotion()) {
    gsap.set(hints, cmdHeld
      ? { autoAlpha: 0.55, width: "auto", marginRight: 5 }
      : { autoAlpha: 0, width: 0, marginRight: 0 });
    return;
  }
  gsap.to(hints, {
    autoAlpha: cmdHeld ? 0.55 : 0,
    width: cmdHeld ? "auto" : 0,
    marginRight: cmdHeld ? 5 : 0,
    duration: tokens.snap,
    ease: cmdHeld ? tokens.easeOutExpo : tokens.easeSoft,
    stagger: cmdHeld ? tokens.stagger.tight : 0,
    overwrite: "auto",
  });
});
</script>

<div class="tabs-wrapper">
	<div class="pill" bind:this={pillEl}>
		<span
			class="pill-indicator"
			bind:this={indicatorEl}
			aria-hidden="true"
		></span>
		{#each tabs as tab, i (tab.id)}
			<button
				bind:this={segmentEls[i]}
				class="pill-segment"
				class:pill-segment--active={activeTab === tab.id}
				class:pill-segment--hovered={hoveredIndex === i}
				onclick={() => onTabChange(tab.id)}
				onpointerenter={() => (hoveredIndex = i)}
				onpointerleave={() => {
					if (hoveredIndex === i) hoveredIndex = null;
				}}
>{#if tab.shortcut}<span class="seg-shortcut">⌘{tab.shortcut}</span>{/if}<span class="seg-label">{tab.label}</span></button>
			{#if i < tabs.length - 1}
				<span
					class="pill-divider"
					class:pill-divider--hidden={isDividerHidden(i)}
					aria-hidden="true"
				></span>
			{/if}
		{/each}
	</div>

	{#if trailing}
		<div class="status-slot">
			{@render trailing()}
		</div>
	{/if}
</div>

<style>
	.tabs-wrapper {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.status-slot {
		position: absolute;
		left: calc(100% + 8px);
		top: 50%;
		height: 18px;
		transform: translateY(-50%);
		pointer-events: none;
	}

	.pill {
		position: relative;
		display: flex;
		align-items: center;
		background: var(--color-tab-track-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--color-glass-border);
		border-radius: 9999px;
		padding: 3px;
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		transform: translateZ(0);
		isolation: isolate;
	}

	.pill-segment {
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 36px;
		padding: 0 20px;
		border-radius: 9999px;
		font-size: 13px;
		font-weight: 500;
		letter-spacing: -0.01em;
		color: var(--color-tab-inactive-text);
		background: transparent;
		border: none;
		cursor: pointer;
		user-select: none;
		white-space: nowrap;
		-webkit-font-smoothing: antialiased;
		/* Color crossfade between inactive / hovered / active states is a paint
		   property, not a motion concern. It stays as CSS — GSAP would just be
		   tweening color values, costing more than the benefit. */
		transition: color var(--duration-snap) var(--ease-soft);
	}

	.pill-segment--hovered:not(.pill-segment--active) {
		color: var(--color-text-secondary);
	}

	.pill-segment--active {
		color: var(--color-text-primary);
	}

	/* The indicator's position, width, and opacity are driven by GSAP from the
	   measurement $effect above — not by CSS. autoAlpha starts at 0 until the
	   first measure runs, which keeps the indicator invisible during the
	   pre-measure flash. */
	.pill-indicator {
		position: absolute;
		top: 3px;
		left: 0;
		height: 36px;
		border-radius: 9999px;
		background: var(--color-tab-active-bg);
		box-shadow:
			var(--color-shadow-indicator),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		pointer-events: none;
		z-index: 0;
		opacity: 0;
		visibility: hidden;
		will-change: transform, width;
	}

	.pill-divider {
		position: relative;
		z-index: 1;
		width: 1px;
		height: 14px;
		background: var(--color-glass-border);
		flex-shrink: 0;
		transition: opacity var(--duration-snap);
	}

	.pill-divider--hidden {
		opacity: 0;
	}

	/* Reveal opacity, width, and margin are driven by GSAP from the cmdHeld
	   $effect above. CSS only sets the rest state and the inherited type props. */
	.seg-shortcut {
		display: inline-block;
		font-size: 11px;
		font-weight: 400;
		font-variant-numeric: tabular-nums;
		color: var(--color-tab-inactive-text);
		opacity: 0;
		width: 0;
		overflow: hidden;
		visibility: hidden;
	}
</style>
