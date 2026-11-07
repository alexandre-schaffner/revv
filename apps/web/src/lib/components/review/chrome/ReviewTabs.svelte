<script lang="ts">
import CloudArrowDown from "phosphor-svelte/lib/CloudArrowDown";
import Spinner from "phosphor-svelte/lib/Spinner";
import PillTabs from "$lib/components/layout/PillTabs.svelte";
import { gsap, prefersReducedMotion, tokens } from "$lib/motion";
import { getIsPullingCommit, pullLatestCommit } from "$lib/review/pull-latest";
import { getLoadedHeadSha } from "$lib/stores/diff-files.svelte";
import {
  getActiveTab,
  REVIEW_TABS,
  type ReviewTab,
  setActiveTab,
} from "$lib/stores/pr-view-state.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import { getPrWalkthroughStatus } from "$lib/walkthrough/store.svelte";

interface Props {
  prId: string;
}

let { prId }: Props = $props();

const pr = $derived(getPrById(prId));
const activeTab = $derived(getActiveTab());
const walkthroughStatus = $derived(getPrWalkthroughStatus(prId));

// For the diff and the Pull button only: the PR's head differs from the SHA
// the diff was loaded at (`getLoadedHeadSha` is null until the first fetch).
// Walkthrough staleness is the server's call (`/current`'s `stale`,
// `lifecycle:superseded`, review-rounds `hasNewCommits`). A closed or merged
// PR's head is final, so there is nothing to pull; its walkthrough stamps
// "Merged" instead.
const hasNewCommit = $derived.by(() => {
  if (!pr?.headSha || pr.status !== "open") return false;
  const loaded = getLoadedHeadSha(prId);
  return loaded !== null && loaded !== pr.headSha;
});
const isPulling = $derived(getIsPullingCommit(prId));

function onPullCommit(): void {
  void pullLatestCommit(prId);
}

// The pull button takes precedence over the dot, since it needs the user to
// act. Both stay in the DOM and crossfade in the same slot.
const dotVisible = $derived(!hasNewCommit && walkthroughStatus !== "idle");
const buttonVisible = $derived(hasNewCommit);
const buttonInteractive = $derived(hasNewCommit && !isPulling);

function handlePullClick(): void {
  if (buttonInteractive) onPullCommit();
}

const TAB_LABEL: Record<ReviewTab, string> = {
  conversation: "Conversation",
  walkthrough: "Walkthrough",
  diff: "Diff",
};

const tabs = REVIEW_TABS.map((id) => ({ id, label: TAB_LABEL[id] }));

let dotEl: HTMLSpanElement | null = $state(null);
let pullBtnEl: HTMLButtonElement | null = $state(null);
let pulseTl: gsap.core.Timeline | null = null;

// How much room the trailing slot currently needs, handed to PillTabs so it
// can keep that room inside the pane (see its trailing-slot clamp). The dot
// is a fixed 6 px; the pull button's width depends on its label, so measure
// it — `offsetWidth` is layout width, unaffected by the GSAP scale below.
const STATUS_DOT_SIZE = 6;
let pullBtnWidth = $state(0);

$effect(() => {
  const btn = pullBtnEl;
  if (!btn) return;
  pullBtnWidth = btn.offsetWidth;
  const observer = new ResizeObserver(() => {
    pullBtnWidth = btn.offsetWidth;
  });
  observer.observe(btn);
  return () => observer.disconnect();
});

const trailingReserve = $derived(buttonVisible ? pullBtnWidth : dotVisible ? STATUS_DOT_SIZE : 0);

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

// Essential, so it keeps pulsing under reduced motion: it's the only sign that
// work is happening.
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

<PillTabs {tabs} {activeTab} onTabChange={setActiveTab} {trailingReserve}>
	{#snippet trailing()}
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
				<Spinner size={12} class="motion-essential-spin" />
			{:else}
				<CloudArrowDown size={12} />
			{/if}
			<span class="pull-btn-label">Pull</span>
		</button>
	{/snippet}
</PillTabs>

<style>
	/*
	 * Both children render into PillTabs' zero-width `.status-slot` anchor
	 * and overlap at `left: 0`, crossfading; only one is visible at a time.
	 */
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

	/* `cursor: default` as well as `pointer-events: none` while hidden: some
	 * browsers still show a disabled-for-pointer button's native cursor, and
	 * the hidden button sits right over the visible dot. */
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
