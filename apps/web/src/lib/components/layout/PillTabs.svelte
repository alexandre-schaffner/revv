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
  /**
   * Width, in px, of whatever the `trailing` snippet is currently showing —
   * 0 when it shows nothing. The snippet's content is out of flow, so this
   * is the only way PillTabs can know how much room to keep for it to the
   * right of the pill. See the trailing-slot clamp below.
   */
  trailingReserve?: number;
}

let {
  tabs,
  activeTab,
  onTabChange,
  trailing,
  cmdHeld = false,
  trailingReserve = 0,
}: Props = $props();

let wrapperEl: HTMLDivElement | null = $state(null);
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

// ── Trailing-slot clamp ──
// The trailing slot is out of flow (see `.status-slot` below), so the pill
// stays centred in its container no matter what the slot holds. The cost is
// that the slot's content hangs past the wrapper's right edge, and the
// container — a floating bar inside an `overflow: hidden` pane — clips it once
// the pane gets narrow. That is what used to slice the walkthrough status dot
// in half with the sidebar and the context panel both open.
//
// So: nudge the whole wrapper left by exactly the amount that would otherwise
// overflow. Zero shift whenever there is room, which is the common case.
const TRAILING_GAP = 8;
const EDGE_GAP = 8;
let shift = 0;
let hasClamped = false;

$effect(() => {
  const wrapper = wrapperEl;
  const container = wrapper?.parentElement;
  const reserve = trailingReserve;
  if (!wrapper || !container) return;

  // `animate` is true only when the slot's content changed size, where the
  // pill easing out of the way reads as motion. Container-driven measures
  // (window resize, panel drag) snap instead — a tween there would trail the
  // pointer for the whole drag.
  const measure = (animate: boolean) => {
    const containerRect = container.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    // Back the applied translation out of the measurement so it reads the
    // wrapper's natural (centred) position and can't feed back on itself.
    // Read it from GSAP rather than from `shift`: mid-tween the two differ.
    const applied = Number(gsap.getProperty(wrapper, "x")) || 0;
    const naturalLeft = wrapperRect.left - applied;
    const naturalRight = wrapperRect.right - applied;
    // Nothing in the slot means nothing to protect — leave the pill centred
    // even if it is itself wider than the container.
    const needed = reserve > 0 ? TRAILING_GAP + reserve : 0;
    const overflow = needed > 0 ? naturalRight + needed - (containerRect.right - EDGE_GAP) : 0;
    // Never shift so far that the pill's own left edge leaves the container:
    // clipping the trailing content beats clipping a tab label. No EDGE_GAP on
    // this side — in a pane this tight, letting the pill sit flush against the
    // left edge is what buys the trailing content the room to stay whole.
    const headroom = Math.max(0, naturalLeft - containerRect.left);
    const next = Math.max(0, Math.min(overflow, headroom));
    if (Math.abs(next - shift) < 0.5) return;
    shift = next;
    if (!animate || prefersReducedMotion()) {
      gsap.set(wrapper, { x: -shift });
      return;
    }
    gsap.to(wrapper, {
      x: -shift,
      duration: tokens.smooth,
      ease: tokens.easeOutExpo,
      overwrite: "auto",
    });
  };

  // First run is initial layout, so it lands without motion.
  measure(hasClamped);
  hasClamped = true;

  const observer = new ResizeObserver(() => measure(false));
  observer.observe(container);
  observer.observe(wrapper);
  return () => observer.disconnect();
});

// Cmd-hold shortcut hint reveal. Animates the ⌘N labels next to each tab
// label when the user holds Cmd. Reveal/hide are simultaneous across all
// segments and symmetric in easing: a modifier-key hint should feel like
// instant feedback, not a ripple. Width is animated to a fixed 22px (not
// `auto`) so GSAP doesn't have to force a layout measurement before tweening.
$effect(() => {
  if (!pillEl) return;
  const hints = pillEl.querySelectorAll<HTMLElement>(".seg-shortcut");
  if (hints.length === 0) return;
  const target = cmdHeld
    ? { opacity: 0.55, width: 22, marginRight: 5 }
    : { opacity: 0, width: 0, marginRight: 0 };
  if (prefersReducedMotion()) {
    gsap.set(hints, target);
    return;
  }
  gsap.to(hints, {
    ...target,
    duration: tokens.snap,
    ease: tokens.easeSoft,
    overwrite: "auto",
  });
});
</script>

<div class="tabs-wrapper" bind:this={wrapperEl}>
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

	/* Anchor for the trailing content, hanging off the pill's right edge.
	   Out of flow so its contents never push the centred pill sideways;
	   zero-width, so consumers position their own children against it with
	   `position: absolute; left: 0`. `height` matches the tallest expected
	   child (an 18 px pill button) so the centre line those children align
	   to stays fixed regardless of which one is showing. The clamp effect
	   above keeps this anchor inside the container. Keep `left` in sync with
	   TRAILING_GAP. */
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
		backdrop-filter: blur(10px) saturate(1.4);
		-webkit-backdrop-filter: blur(10px) saturate(1.4);
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
	   $effect above. CSS only sets the rest state and the inherited type props.
	   No `visibility: hidden` — that adds a frame of opacity → visibility
	   sequencing that makes the modifier-key reveal feel laggy. */
	.seg-shortcut {
		display: inline-block;
		font-size: 11px;
		font-weight: 400;
		font-variant-numeric: tabular-nums;
		color: var(--color-tab-inactive-text);
		opacity: 0;
		width: 0;
		overflow: hidden;
		pointer-events: none;
	}
</style>
