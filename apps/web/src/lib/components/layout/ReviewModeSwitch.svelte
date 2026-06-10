<script lang="ts">
import type { ReviewMode } from "@revv/shared";
import User from "phosphor-svelte/lib/User";
import Users from "phosphor-svelte/lib/Users";
import { gsap, prefersReducedMotion, tokens } from "$lib/motion";

interface Props {
  mode: ReviewMode;
  onSelect: (mode: ReviewMode) => void;
}

let { mode, onSelect }: Props = $props();

const segments = [
  {
    id: "reviewer" as const,
    label: "Reviewer",
    icon: Users,
    hint: "Review someone else's PR",
  },
  {
    id: "author" as const,
    label: "Self-review",
    icon: User,
    hint: "Self-review your own PR before requesting review",
  },
];

let trackEl: HTMLDivElement | null = $state(null);
let indicatorEl: HTMLSpanElement | null = $state(null);
let segmentEls = $state<(HTMLButtonElement | null)[]>([]);
let hoveredIndex = $state<number | null>(null);
let hasMeasured = $state(false);

// Sliding indicator driven imperatively via GSAP — the same proven technique
// PillTabs uses for the main tab bar. First measure jumps (gsap.set),
// subsequent ones tween; overwrite:auto cancels in-flight tweens on rapid
// switches. A ResizeObserver re-measures when segment widths change (font
// load, container resize) so the indicator never drifts off its segment.
$effect(() => {
  const activeIndex = segments.findIndex((s) => s.id === mode);
  const index = hoveredIndex ?? activeIndex;
  const el = segmentEls[index];
  if (!el || !indicatorEl) return;

  const measure = () => {
    const seg = el;
    if (!trackEl || !seg || !indicatorEl) return;
    const trackRect = trackEl.getBoundingClientRect();
    const segRect = seg.getBoundingClientRect();
    const borderLeft = parseFloat(getComputedStyle(trackEl).borderLeftWidth) || 0;
    const left = Math.round(segRect.left - trackRect.left - borderLeft);
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
  if (trackEl) observer.observe(trackEl);
  return () => observer.disconnect();
});
</script>

<div
	class="mode-switch"
	role="group"
	aria-label="Review mode"
	bind:this={trackEl}
>
	<span class="mode-indicator" bind:this={indicatorEl} aria-hidden="true"></span>
	{#each segments as seg, i (seg.id)}
		{@const Icon = seg.icon}
		<button
			bind:this={segmentEls[i]}
			type="button"
			class="mode-segment"
			class:mode-segment--active={mode === seg.id}
			class:mode-segment--hovered={hoveredIndex === i}
			aria-pressed={mode === seg.id}
			title={seg.hint}
			onclick={() => onSelect(seg.id)}
			onpointerenter={() => (hoveredIndex = i)}
			onpointerleave={() => {
				if (hoveredIndex === i) hoveredIndex = null;
			}}
		>
			<Icon size={14} weight={mode === seg.id ? 'fill' : 'regular'} />
			<span class="mode-label">{seg.label}</span>
		</button>
	{/each}
</div>

<style>
	/* Compact sibling of the main tab pill (PillTabs). Same glass track, same
	   GSAP-driven sliding indicator, tuned down to a header-control scale. */
	.mode-switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		padding: 3px;
		border-radius: 9999px;
		background: var(--color-tab-track-bg);
		border: 1px solid var(--color-glass-border);
		box-shadow:
			var(--color-glass-shadow),
			inset 0 0.5px 0 0 var(--color-glass-highlight);
		backdrop-filter: blur(10px) saturate(1.4);
		-webkit-backdrop-filter: blur(10px) saturate(1.4);
		transform: translateZ(0);
		isolation: isolate;
	}

	.mode-segment {
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 26px;
		padding: 0 12px;
		border: none;
		border-radius: 9999px;
		background: transparent;
		color: var(--color-tab-inactive-text);
		font-size: 12px;
		font-weight: 500;
		letter-spacing: -0.01em;
		line-height: 1;
		white-space: nowrap;
		cursor: pointer;
		user-select: none;
		-webkit-font-smoothing: antialiased;
		/* Color crossfade between states is a paint property — stays on CSS,
		   matching PillTabs' reasoning. */
		transition: color var(--duration-snap) var(--ease-soft);
	}

	.mode-segment--hovered:not(.mode-segment--active) {
		color: var(--color-text-secondary);
	}

	.mode-segment--active {
		color: var(--color-text-primary);
	}

	/* Position/width/opacity owned by GSAP (effect above). autoAlpha keeps it
	   invisible until the first measure to avoid a pre-measure flash. */
	.mode-indicator {
		position: absolute;
		top: 3px;
		left: 0;
		height: 26px;
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
</style>
