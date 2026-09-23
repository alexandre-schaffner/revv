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
 *  destructive buttons are disabled with a contextual tooltip. Also covers
 *  the diff refresh in `handleRegenerate`'s stale branch, which runs before
 *  `regenerate` takes the pending slot. */
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
 * The stale pill reviews the commits that made it stale, so it refreshes
 * the diff first via `reviewLatestCommit` (the same pull-then-review path
 * as the tab-side Pull button); otherwise the diff tab still shows the old
 * head and the Pull button stays lit after review.
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
