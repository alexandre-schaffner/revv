<script lang="ts">
import ArrowDown from "phosphor-svelte/lib/ArrowDown";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import Star from "phosphor-svelte/lib/Star";
import GenActionBar, { type GenActionState } from "$lib/components/layout/GenActionBar.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
import { isChatStreaming } from "$lib/stores/chat.svelte";
import { getIsPullingCommit, getReviewMode, reviewLatestCommit } from "$lib/stores/review.svelte";
import {
  abort as abortWalkthrough,
  generateWalkthrough,
  getHasUnreviewedCommits,
  getPendingAction as getWalkthroughPendingAction,
  getRatings as getWalkthroughRatings,
  getWalkthroughUiState,
  loadReviewRounds,
  regenerate as regenerateWalkthrough,
  regenerateFromScratch as regenerateWalkthroughFromScratch,
  resume as resumeWalkthrough,
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
const selectedMode = $derived(getReviewMode(prId));
const hasUnreviewedCommits = $derived(getHasUnreviewedCommits(prId, selectedMode));
const reviewNewCommitsLabel = "Review new commits";

$effect(() => {
  void loadReviewRounds(prId, selectedMode);
});

/** Map walkthrough-specific state to the normalised GenActionState. */
const genActionState = $derived.by((): GenActionState | null => {
  switch (walkthroughUiState.kind) {
    case "absent":
    case "idle":
      if (hasUnreviewedCommits) {
        return { kind: "stale", label: reviewNewCommitsLabel };
      }
      return { kind: "empty", label: "Generate walkthrough" };
    case "streaming":
      return { kind: "streaming" };
    case "resumable":
      return { kind: "resumable" };
    case "error-partial":
    case "error-empty":
      return { kind: "error" };
    case "complete":
      if (hasUnreviewedCommits) {
        return { kind: "stale", label: reviewNewCommitsLabel };
      }
      return { kind: "complete" };
    case "complete-stale":
      return { kind: "stale", label: reviewNewCommitsLabel };
    default:
      return null;
  }
});

/** When chat is streaming, treat it as an in-flight action so the
 *  destructive buttons are disabled with a contextual tooltip. The diff
 *  refresh that opens `handleRegenerate`'s stale branch counts too: it runs
 *  before `regenerate` takes the pending slot, so without it the pill stays
 *  live through the whole pull and reads as if the click did nothing. */
const pullingCommit = $derived(getIsPullingCommit(prId));
const combinedPendingAction = $derived(
  chatStreaming ? "chat" : pullingCommit ? "regenerate" : walkthroughPendingAction,
);
const combinedDisabledTitle = $derived(
  chatStreaming
    ? "Chat edit in progress. Wait for it to finish before regenerating."
    : pullingCommit
      ? "Fetching the new commits…"
      : undefined,
);

/**
 * The stale pill's primary action reviews the commits that made this
 * walkthrough stale, so it has to refresh the diff first — otherwise the
 * new review lands while the diff tab still renders the old head, the Pull
 * button stays lit, and the user is told to act on the same commits twice.
 * `reviewLatestCommit` is the same pull-then-review path the tab-side Pull
 * button feeds; `complete` keeps the plain regenerate (nothing to pull).
 */
const isStale = $derived(genActionState?.kind === "stale");

function handleRegenerate(): void {
  if (isStale) {
    void reviewLatestCommit(prId, selectedMode);
    return;
  }
  void regenerateWalkthrough(prId, selectedMode);
}
</script>

{#if genActionState}
  <div
    class="actions-float"
    in:gsapFadeY={{ duration: tokens.quick, y: 8 }}
    out:gsapFade={{ duration: tokens.snap }}
  >
    <div class="actions-row" role="toolbar" aria-label="Walkthrough actions">
      <GlassPill
        icon
        onclick={scrollWalkthroughToTop}
        aria-label="Scroll to top of walkthrough"
      >
        <ArrowUp size={16} />
      </GlassPill>

      <GenActionBar
        uiState={genActionState}
        pendingAction={combinedPendingAction}
        disabledTitle={combinedDisabledTitle}
        onStop={() => abortWalkthrough(prId)}
        onResume={() => resumeWalkthrough(prId, selectedMode)}
        onGenerate={() => generateWalkthrough(prId, selectedMode)}
        onRegenerate={handleRegenerate}
        onRegenerateFromScratch={() => regenerateWalkthroughFromScratch(prId)}
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
            <ArrowDown size={16} />
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
