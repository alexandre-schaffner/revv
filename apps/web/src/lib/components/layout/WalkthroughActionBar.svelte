<script lang="ts">
import ArrowDown from "phosphor-svelte/lib/ArrowDown";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import Star from "phosphor-svelte/lib/Star";
import GenActionBar, { type GenActionState } from "$lib/components/layout/GenActionBar.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { gsapFade, gsapFadeY, setupFlipOnChange, tokens } from "$lib/motion";
import { isChatStreaming } from "$lib/stores/chat.svelte";
import {
  abort as abortWalkthrough,
  getPendingAction as getWalkthroughPendingAction,
  getRatings as getWalkthroughRatings,
  getWalkthroughUiState,
  regenerate as regenerateWalkthrough,
  resume as resumeWalkthrough,
  startWalkthrough,
} from "$lib/stores/walkthrough.svelte";
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

/** Map walkthrough-specific state to the normalised GenActionState. */
const genActionState = $derived.by((): GenActionState | null => {
  switch (walkthroughUiState.kind) {
    case "absent":
    case "idle":
      return { kind: "empty", label: "Generate walkthrough" };
    case "streaming":
      return { kind: "streaming" };
    case "resumable":
      return { kind: "resumable" };
    case "error-partial":
    case "error-empty":
      return { kind: "error" };
    case "complete":
      return { kind: "complete" };
    case "complete-stale":
      return { kind: "stale", label: "Regenerate for latest commit" };
    default:
      return null;
  }
});

/** When chat is streaming, treat it as an in-flight action so the
 *  destructive buttons are disabled with a contextual tooltip. */
const combinedPendingAction = $derived(chatStreaming ? "chat" : walkthroughPendingAction);
const combinedDisabledTitle = $derived(
  chatStreaming ? "Chat edit in progress. Wait for it to finish before regenerating." : undefined,
);

// Flip ride for the GenActionBar swap: when the central pill changes width
// (e.g. `Stop generation` → `Regenerate`), the surviving siblings (scroll-
// top, New content, Rating) slide to their new positions instead of jumping.
let actionsRowEl = $state<HTMLDivElement | null>(null);
setupFlipOnChange(
  () => actionsRowEl,
  () => genActionState?.kind,
);
</script>

{#if genActionState}
  <div
    class="actions-float"
    in:gsapFadeY={{ duration: tokens.quick, y: 8 }}
    out:gsapFade={{ duration: tokens.snap }}
  >
    <div
      bind:this={actionsRowEl}
      class="actions-row"
      role="toolbar"
      aria-label="Walkthrough actions"
    >
      <GlassPill
        icon
        onclick={scrollWalkthroughToTop}
        aria-label="Scroll to top of walkthrough"
      >
        <ArrowUp size={16} weight="regular" />
      </GlassPill>

      <GenActionBar
        uiState={genActionState}
        pendingAction={combinedPendingAction}
        disabledTitle={combinedDisabledTitle}
        onStop={() => abortWalkthrough(prId)}
        onResume={() => resumeWalkthrough(prId)}
        onGenerate={() => startWalkthrough(prId)}
        onRegenerate={() => regenerateWalkthrough(prId)}
      />

      {#if walkthroughUiState.kind === "streaming" && walkthroughHasNewContentBelow}
        <!-- Inline-flex wrapper so the Svelte transition has a real box.
             80ms in-delay damps flicker if the user scrolls past the
             threshold and immediately back. -->
        <span
          class="pill-wrap"
          in:gsapFadeY={{ duration: tokens.quick, y: 4, delay: 0.08 }}
          out:gsapFade={{ duration: tokens.snap }}
        >
          <GlassPill
            onclick={scrollWalkthroughToBottom}
            aria-label="Scroll to newest walkthrough content"
          >
            <ArrowDown size={16} weight="regular" />
            New content
          </GlassPill>
        </span>
      {/if}

      {#if walkthroughHasRatings}
        <span
          class="pill-wrap"
          in:gsapFadeY={{ duration: tokens.quick, y: 4 }}
          out:gsapFade={{ duration: tokens.snap }}
        >
          <GlassPill
            onclick={scrollWalkthroughToRatings}
            aria-label="Scroll to rating panel"
          >
            <Star size={16} weight="fill" />
            Rating
          </GlassPill>
        </span>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Transition-only wrapper. `inline-flex` keeps it a flex item of
     `.actions-row` so the gap rule continues to work. */
  .pill-wrap {
    display: inline-flex;
    align-items: center;
  }
</style>
