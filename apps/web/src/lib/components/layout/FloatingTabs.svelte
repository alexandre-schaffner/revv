<script lang="ts">
import type { ReviewMode } from "@revv/shared";
import DownloadCloud from "phosphor-svelte/lib/CloudArrowDown";
import Loader2 from "phosphor-svelte/lib/Spinner";
import { gsap, prefersReducedMotion, tokens } from "$lib/motion";
import { getCmdHeld } from "$lib/stores/shortcuts.svelte";
import PillTabs from "./PillTabs.svelte";
import ReviewModeSwitch from "./ReviewModeSwitch.svelte";

type Tab = "walkthrough" | "diff" | "request-changes";
type WalkthroughStatus = "idle" | "generating" | "complete" | "error";

interface Props {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  walkthroughStatus?: WalkthroughStatus;
  /**
   * True when the PR the user is viewing has a newer headSha than the
   * diff currently rendered — signals "pull this commit to refresh".
   */
  hasNewCommit?: boolean;
  /** True while the pull is in-flight (refetching + regenerating). */
  isPulling?: boolean;
  onPullCommit?: () => void;
  /** Active review lens. Omitted when not on a PR review route. */
  reviewMode?: ReviewMode | undefined;
  onReviewModeChange?: ((mode: ReviewMode) => void) | undefined;
}

let {
  activeTab,
  onTabChange,
  walkthroughStatus = "idle",
  hasNewCommit = false,
  isPulling = false,
  onPullCommit,
  reviewMode,
  onReviewModeChange,
}: Props = $props();

// The dot and the pull button live in the same slot to the right of the
// pill tabs. Only one is visible at a time — the pull affordance takes
// precedence because it requires user action; walkthrough status is
// passive info. Both elements stay in the DOM so opacity + scale
// transitions run on mount/unmount of visibility, producing a clean
// crossfade rather than a layout-shifting morph.
const dotVisible = $derived(!hasNewCommit && walkthroughStatus !== "idle");
const buttonVisible = $derived(hasNewCommit);
const buttonInteractive = $derived(hasNewCommit && !isPulling);

function handlePullClick(): void {
  if (buttonInteractive) onPullCommit?.();
}

const cmdHeld = $derived(getCmdHeld());

const tabs = [
  { id: "walkthrough" as Tab, label: "Walkthrough", shortcut: "1" },
  { id: "diff" as Tab, label: "Diff", shortcut: "2" },
  { id: "request-changes" as Tab, label: "Request Changes", shortcut: "3" },
];

function handleTabChange(tabId: string) {
  onTabChange(tabId as Tab);
}

let dotEl: HTMLSpanElement | null = $state(null);
let pullBtnEl: HTMLButtonElement | null = $state(null);
let pulseTl: gsap.core.Timeline | null = null;

// Status-dot visibility (autoAlpha + scale crossfade). Replaces the CSS
// transitions on `.status-dot { transition: opacity, transform, ... }`.
$effect(() => {
  if (!dotEl) return;
  if (prefersReducedMotion()) {
    gsap.set(dotEl, dotVisible ? { autoAlpha: 1, scale: 1 } : { autoAlpha: 0, scale: 0.6 });
    return;
  }
  gsap.to(dotEl, {
    autoAlpha: dotVisible ? 1 : 0,
    scale: dotVisible ? 1 : 0.6,
    duration: tokens.smooth,
    ease: tokens.easeOutExpo,
    overwrite: "auto",
  });
});

// Status-dot pulse loop while the walkthrough is generating. Replaces the
// `@keyframes status-dot-pulse` driven by `.status-dot--generating.status-dot--visible`.
// Marked essential so the pulse continues under prefers-reduced-motion:
// it's the only liveness signal that work is happening.
$effect(() => {
  if (!dotEl) return;
  const shouldPulse = dotVisible && walkthroughStatus === "generating";
  pulseTl?.kill();
  pulseTl = null;
  if (!shouldPulse) {
    gsap.set(dotEl, { opacity: 1 });
    return;
  }
  pulseTl = gsap.timeline({ repeat: -1, yoyo: true }).to(dotEl, {
    opacity: 0.45,
    duration: tokens.pulse / 2,
    ease: tokens.easeSoft,
  });
  return () => {
    pulseTl?.kill();
    pulseTl = null;
  };
});

// Pull-button crossfade. Replaces the CSS transitions on `.pull-btn`.
$effect(() => {
  if (!pullBtnEl) return;
  if (prefersReducedMotion()) {
    gsap.set(pullBtnEl, buttonVisible ? { autoAlpha: 1, scale: 1 } : { autoAlpha: 0, scale: 0.85 });
    return;
  }
  gsap.to(pullBtnEl, {
    autoAlpha: buttonVisible ? 1 : 0,
    scale: buttonVisible ? 1 : 0.85,
    duration: tokens.smooth,
    ease: tokens.easeOutExpo,
    overwrite: "auto",
  });
});
</script>

<PillTabs {tabs} {activeTab} onTabChange={handleTabChange} {cmdHeld}>
	{#snippet leading()}
		{#if reviewMode && onReviewModeChange}
			<ReviewModeSwitch mode={reviewMode} onSelect={onReviewModeChange} />
		{/if}
	{/snippet}
	{#snippet trailing()}
		<div class="status-slot" aria-hidden={!dotVisible && !buttonVisible}>
			<span
				bind:this={dotEl}
				class="status-dot"
				class:status-dot--generating={walkthroughStatus === 'generating'}
				class:status-dot--complete={walkthroughStatus === 'complete'}
				class:status-dot--error={walkthroughStatus === 'error'}
				aria-hidden="true"
			></span>

			<button
				bind:this={pullBtnEl}
				type="button"
				class="pull-btn"
				class:pull-btn--visible={buttonVisible}
				class:pull-btn--pulling={isPulling}
				disabled={!buttonInteractive}
				tabindex={buttonVisible && !isPulling ? 0 : -1}
				aria-hidden={!buttonVisible}
				onclick={handlePullClick}
				title={isPulling ? 'Pulling new commit…' : 'New commit. Click to pull.'}
				aria-label={isPulling
					? 'Pulling new commit'
					: 'New commit available. Click to pull the latest changes.'}
			>
				{#if isPulling}
					<Loader2 size={12} weight="regular" class="motion-essential-spin" />
				{:else}
					<DownloadCloud size={12} weight="fill" />
				{/if}
				<span class="pull-btn-label">Pull</span>
			</button>
		</div>
	{/snippet}
</PillTabs>

<style>
	/*
	 * Status slot — anchored to the right of the pill. Holds two stacked
	 * children (the walkthrough-status dot and the pull button). The slot
	 * is `position: absolute` so it never pushes the centered tabs wrapper
	 * leftward when the button appears.
	 *
	 * The two children are also `position: absolute` with `left: 0`, so
	 * they occupy the same anchor and crossfade via opacity + scale.
	 * Only one is visible at a time; the other sits invisible and
	 * non-interactive underneath.
	 */
	.status-slot {
		position: absolute;
		left: calc(100% + var(--spacing-island));
		top: 50%;
		/* Height matches the tallest child (the 18 px button) so the
		 * slot's center line — which both children align to — stays fixed
		 * regardless of which one is currently visible. */
		height: 18px;
		transform: translateY(-50%);
		pointer-events: none;
	}

	/* ── Walkthrough status dot (6 × 6, centered in the slot) ──
	   Visibility, scale, and the generating-pulse loop are all driven by GSAP
	   from the $effect blocks above. CSS only sets layout + background-color
	   keyed to status. autoAlpha (used by GSAP) sets `visibility: hidden`
	   automatically when opacity is 0, which provides pointer-events safety. */
	.status-dot {
		position: absolute;
		left: 0;
		top: calc(50% - 3px);
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: transparent;
		opacity: 0;
		visibility: hidden;
		transform-origin: left center;
		pointer-events: none;
		cursor: default;
		/* Background-color crossfade between status states is a paint property
		   and stays on CSS — see the same reasoning in PillTabs.svelte. */
		transition: background-color var(--duration-snap) var(--ease-soft);
	}

	.status-dot--generating {
		background: var(--color-accent);
	}

	.status-dot--complete {
		background: var(--color-success);
	}

	.status-dot--error {
		background: var(--color-danger);
	}

	/* ── Pull button (amber pill, 18 px tall, auto width) ──
	 * Invisible state: pointer-events: none AND cursor: default. The cursor
	 * declaration is important — `pointer-events: none` alone prevents clicks
	 * but some browsers still reflect the button's native cursor on hover,
	 * which would wrongly flip the cursor to pointer over the dot's bounds
	 * (the invisible button sits right on top of the visible dot). */
	/* Crossfade in/out is driven by GSAP from the $effect above. Background
	   color crossfade on hover stays as CSS (paint property). */
	.pull-btn {
		position: absolute;
		left: 0;
		top: 0;
		display: inline-flex;
		align-items: center;
		gap: var(--spacing-island-half);
		height: 18px;
		padding: 0 10px 0 8px;
		border: none;
		border-radius: 9999px;
		background: var(--color-warning);
		color: var(--color-warning-fg);
		font-family: inherit;
		font-size: 11px;
		font-weight: 500;
		line-height: 1;
		letter-spacing: -0.01em;
		white-space: nowrap;
		cursor: default;
		box-shadow: 0 1px 2px color-mix(in srgb, var(--color-warning) 40%, transparent);
		opacity: 0;
		visibility: hidden;
		transform-origin: left center;
		pointer-events: none;
		transition: background-color var(--duration-snap) var(--ease-soft);
		-webkit-font-smoothing: antialiased;
	}

	.pull-btn--visible {
		pointer-events: auto;
		cursor: pointer;
	}

	.pull-btn--visible.pull-btn--pulling {
		cursor: progress;
	}

	.pull-btn--visible:not(.pull-btn--pulling):hover {
		background: color-mix(in srgb, var(--color-warning) 88%, black);
	}

	.pull-btn:focus-visible {
		outline: 2px solid var(--color-warning);
		outline-offset: 2px;
	}

	.pull-btn-label {
		line-height: 1;
	}

</style>
