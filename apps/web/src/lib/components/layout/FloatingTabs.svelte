<script lang="ts">
import DownloadCloud from "phosphor-svelte/lib/CloudArrowDown";
import Loader2 from "phosphor-svelte/lib/Spinner";
import { getCmdHeld } from "$lib/stores/shortcuts.svelte";
import PillTabs from "./PillTabs.svelte";

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
}

let {
  activeTab,
  onTabChange,
  walkthroughStatus = "idle",
  hasNewCommit = false,
  isPulling = false,
  onPullCommit,
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
</script>

<PillTabs {tabs} {activeTab} onTabChange={handleTabChange} {cmdHeld}>
	{#snippet trailing()}
		<div class="status-slot" aria-hidden={!dotVisible && !buttonVisible}>
			<span
				class="status-dot"
				class:status-dot--visible={dotVisible}
				class:status-dot--generating={walkthroughStatus === 'generating'}
				class:status-dot--complete={walkthroughStatus === 'complete'}
				class:status-dot--error={walkthroughStatus === 'error'}
				aria-hidden="true"
			></span>

			<button
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
					<Loader2 size={12} weight="regular" class="animate-spin" />
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

	/* ── Walkthrough status dot (6 × 6, centered in the slot) ── */
	.status-dot {
		position: absolute;
		left: 0;
		top: 50%;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: transparent;
		opacity: 0;
		transform: translateY(-50%) scale(0.6);
		transform-origin: left center;
		/* Decorative only — never interactive, even when visible. */
		pointer-events: none;
		cursor: default;
		transition:
			opacity var(--duration-smooth) var(--ease-out-expo),
			transform var(--duration-smooth) var(--ease-out-expo),
			background-color var(--duration-snap);
	}

	.status-dot--visible {
		opacity: 1;
		transform: translateY(-50%) scale(1);
	}

	.status-dot--generating {
		background: var(--color-accent);
	}

	.status-dot--visible.status-dot--generating {
		animation: status-dot-pulse var(--duration-pulse) var(--ease-soft) infinite;
	}

	.status-dot--complete {
		background: var(--color-success);
	}

	.status-dot--error {
		background: var(--color-danger);
	}

	@keyframes status-dot-pulse {
		0%, 100% { opacity: 1; }
		50%      { opacity: 0.45; }
	}

	/* ── Pull button (amber pill, 18 px tall, auto width) ──
	 * Invisible state: pointer-events: none AND cursor: default. The cursor
	 * declaration is important — `pointer-events: none` alone prevents clicks
	 * but some browsers still reflect the button's native cursor on hover,
	 * which would wrongly flip the cursor to pointer over the dot's bounds
	 * (the invisible button sits right on top of the visible dot). */
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
		transform: scale(0.85);
		transform-origin: left center;
		pointer-events: none;
		transition:
			opacity var(--duration-smooth) var(--ease-out-expo),
			transform var(--duration-smooth) var(--ease-out-expo),
			background-color var(--duration-snap);
		-webkit-font-smoothing: antialiased;
	}

	.pull-btn--visible {
		opacity: 1;
		transform: scale(1);
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

	@media (prefers-reduced-motion: reduce) {
		.status-dot,
		.pull-btn {
			transition-duration: 0ms;
		}
		.status-dot--visible.status-dot--generating {
			animation: none;
		}
	}
</style>
