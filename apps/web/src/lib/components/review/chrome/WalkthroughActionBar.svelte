<script lang="ts">
import ArrowDown from "phosphor-svelte/lib/ArrowDown";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import Star from "phosphor-svelte/lib/Star";
import { isChatStreaming } from "$lib/chat/timeline.svelte";
import GenActionBar, { type GenActionState } from "$lib/components/shared/GenActionBar.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
import { getIsPullingCommit, reviewLatestCommit } from "$lib/review/pull-latest";
import { getScrollRoot, scrollToAnchor } from "$lib/stores/review-nav.svelte";
import {
  getHasUnreviewedCommits,
  getSelectedMode,
  getPendingAction as getWalkthroughPendingAction,
  getRatings as getWalkthroughRatings,
  getWalkthroughUiState,
} from "$lib/stores/walkthrough.svelte";
import {
  abort as abortWalkthrough,
  generateWalkthrough,
  regenerate as regenerateWalkthrough,
  regenerateFromScratch as regenerateWalkthroughFromScratch,
  resume as resumeWalkthrough,
} from "$lib/stores/walkthrough-actions";
import {
  WALKTHROUGH_PERSPECTIVE_OPTIONS,
  WALKTHROUGH_PERSPECTIVES,
} from "$lib/utils/walkthrough-perspective";

interface Props {
  prId: string;
}

let { prId }: Props = $props();

const scrollRoot = $derived(getScrollRoot("walkthrough"));

let userScrolledUp = $state(false);
let scrollHeightWhenLeft = $state(0);
let currentScrollHeight = $state(0);

$effect(() => {
  const el = scrollRoot;
  userScrolledUp = false;
  scrollHeightWhenLeft = 0;
  currentScrollHeight = 0;
  if (!el) return;
  const onScroll = (): void => {
    currentScrollHeight = el.scrollHeight;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (atBottom) {
      userScrolledUp = false;
      scrollHeightWhenLeft = 0;
    } else if (!userScrolledUp && el.scrollTop > 0) {
      scrollHeightWhenLeft = el.scrollHeight;
      userScrolledUp = true;
    }
  };
  el.addEventListener("scroll", onScroll);
  return () => el.removeEventListener("scroll", onScroll);
});

const walkthroughHasNewContentBelow = $derived(
  userScrolledUp && currentScrollHeight > scrollHeightWhenLeft,
);

function scrollToTop(): void {
  scrollRoot?.scrollTo({ top: 0, behavior: "smooth" });
}

function scrollToBottom(): void {
  if (!scrollRoot) return;
  userScrolledUp = false;
  scrollHeightWhenLeft = 0;
  currentScrollHeight = 0;
  scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: "smooth" });
}

function scrollToRatings(): void {
  scrollToAnchor("walkthrough", "walkthrough-rating");
}

const walkthroughUiState = $derived(getWalkthroughUiState(prId));
const walkthroughPendingAction = $derived(getWalkthroughPendingAction(prId));
const walkthroughHasRatings = $derived(getWalkthroughRatings(prId).length > 0);
const chatStreaming = $derived(isChatStreaming(prId));
const selectedMode = $derived(getSelectedMode(prId));
const hasUnreviewedCommits = $derived(getHasUnreviewedCommits(prId));
const reviewNewCommitsLabel = "Review new commits";

/** Map walkthrough-specific state to the normalised GenActionState. */
const genActionState = $derived.by((): GenActionState | null => {
  switch (walkthroughUiState.kind) {
    case "absent":
    case "idle":
      if (hasUnreviewedCommits) {
        return { kind: "stale", label: reviewNewCommitsLabel };
      }
      return { kind: "empty", label: WALKTHROUGH_PERSPECTIVES[selectedMode].generateLabel };
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

// The walkthrough's perspective is the user's pick; the caret on the pills
// that start a fresh run offers the other one. Comments and the diff stay on
// the identity-derived session either way.
const perspective = $derived({ value: selectedMode, options: WALKTHROUGH_PERSPECTIVE_OPTIONS });

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
        onclick={scrollToTop}
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
        onGenerate={(next) => generateWalkthrough(prId, next ?? selectedMode)}
        onRegenerate={handleRegenerate}
        onRegenerateFromScratch={(next) =>
          regenerateWalkthroughFromScratch(prId, next ?? selectedMode)}
        {perspective}
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
            onclick={scrollToBottom}
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
            onclick={scrollToRatings}
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
