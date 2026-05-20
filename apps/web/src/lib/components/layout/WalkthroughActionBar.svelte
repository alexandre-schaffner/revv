<script lang="ts">
import ArrowDown from "phosphor-svelte/lib/ArrowDown";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import Gauge from "phosphor-svelte/lib/Gauge";
import Play from "phosphor-svelte/lib/Play";
import RefreshCw from "phosphor-svelte/lib/ArrowsClockwise";
import RotateCcw from "phosphor-svelte/lib/ArrowCounterClockwise";
import Square from "phosphor-svelte/lib/Square";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { isChatStreaming } from "$lib/stores/chat.svelte";
import {
  abort as abortWalkthrough,
  getPendingAction as getWalkthroughPendingAction,
  regenerate as regenerateWalkthrough,
  resume as resumeWalkthrough,
} from "$lib/stores/walkthrough-stream.svelte";
import { getWalkthroughUiState } from "$lib/stores/walkthrough-ui-state.svelte";
import { getRatings as getWalkthroughRatings } from "$lib/stores/walkthrough.svelte";
import {
  getHasNewContentBelow as getWalkthroughHasNewContentBelow,
  scrollToBottom as scrollWalkthroughToBottom,
  scrollToRatings as scrollWalkthroughToRatings,
  scrollToTop as scrollWalkthroughToTop,
} from "$lib/stores/walkthroughNav.svelte";

interface Props {
  prId: string;
}

let { prId }: Props = $props();

const walkthroughUiState = $derived(getWalkthroughUiState());
const walkthroughPendingAction = $derived(getWalkthroughPendingAction(prId));
const walkthroughHasRatings = $derived(getWalkthroughRatings().length > 0);
const walkthroughHasNewContentBelow = $derived(getWalkthroughHasNewContentBelow());
const chatStreaming = $derived(isChatStreaming(prId));

const destructiveDisabled = $derived(walkthroughPendingAction !== null || chatStreaming);
const destructiveTitle = $derived(
  chatStreaming
    ? "Chat edit in progress — wait for it to finish before regenerating"
    : walkthroughPendingAction === "regenerate"
      ? "Regenerating…"
      : walkthroughPendingAction === "resume"
        ? "Resuming…"
        : undefined,
);
</script>

<div class="walkthrough-actions-float">
  <div class="walkthrough-actions-row">
    <GlassPill
      icon
      onclick={scrollWalkthroughToTop}
      aria-label="Scroll to top of walkthrough"
    >
      <ArrowUp size={14} />
    </GlassPill>

    {#if walkthroughUiState.kind === "streaming"}
      <GlassPill
        variant="danger"
        onclick={() => abortWalkthrough(prId)}
      >
        <Square size={14} fill="currentColor" />
        Stop generation
      </GlassPill>
      {#if walkthroughHasNewContentBelow}
        <GlassPill
          onclick={scrollWalkthroughToBottom}
          aria-label="Scroll to newest walkthrough content"
        >
          <ArrowDown size={14} />
          New content
        </GlassPill>
      {/if}
    {:else if walkthroughUiState.kind === "resumable"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle}
        onclick={() => resumeWalkthrough(prId)}
        aria-label="Resume walkthrough from where it stopped"
      >
        <Play size={14} fill="currentColor" />
        Resume
      </GlassPill>
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle}
        onclick={() => regenerateWalkthrough(prId)}
      >
        <RefreshCw size={14} />
        Regenerate
      </GlassPill>
    {:else if walkthroughUiState.kind === "error-partial"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle}
        onclick={() => resumeWalkthrough(prId)}
        aria-label="Retry walkthrough from where it failed"
      >
        <RotateCcw size={14} />
        Retry
      </GlassPill>
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle}
        onclick={() => regenerateWalkthrough(prId)}
      >
        <RefreshCw size={14} />
        Regenerate
      </GlassPill>
    {:else if walkthroughUiState.kind === "error-empty"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle}
        onclick={() => regenerateWalkthrough(prId)}
        aria-label="Retry walkthrough generation after error"
      >
        <RefreshCw size={14} />
        Retry
      </GlassPill>
    {:else if walkthroughUiState.kind === "complete"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle}
        onclick={() => regenerateWalkthrough(prId)}
      >
        <RefreshCw size={14} />
        Regenerate
      </GlassPill>
    {:else if walkthroughUiState.kind === "complete-stale"}
      <GlassPill
        variant="accent"
        disabled={destructiveDisabled}
        title={chatStreaming
          ? "Chat edit in progress — wait for it to finish before regenerating"
          : "A newer commit landed — this walkthrough is for an older SHA. Regenerate against the latest."}
        onclick={() => regenerateWalkthrough(prId)}
      >
        <RefreshCw size={14} />
        Regenerate for latest commit
      </GlassPill>
    {/if}

    {#if walkthroughHasRatings}
      <GlassPill
        onclick={scrollWalkthroughToRatings}
        aria-label="Scroll to rating panel"
      >
        <Gauge size={14} />
        Rating
      </GlassPill>
    {/if}
  </div>
</div>

<style>
  .walkthrough-actions-float {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    padding: 8px 0 10px;
    z-index: 10;
    pointer-events: none;
  }

  .walkthrough-actions-float :global(*) {
    pointer-events: auto;
  }

  .walkthrough-actions-row {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-island);
  }
</style>
