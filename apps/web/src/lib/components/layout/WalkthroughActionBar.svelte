<script lang="ts">
import ArrowDown from "phosphor-svelte/lib/ArrowDown";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import Star from "phosphor-svelte/lib/Star";
import GenActionBar, { type GenActionState } from "$lib/components/layout/GenActionBar.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { isChatStreaming } from "$lib/stores/chat.svelte";
import { getRatings as getWalkthroughRatings } from "$lib/stores/walkthrough.svelte";
import {
  abort as abortWalkthrough,
  getPendingAction as getWalkthroughPendingAction,
  regenerate as regenerateWalkthrough,
  resume as resumeWalkthrough,
} from "$lib/stores/walkthrough-stream.svelte";
import { getWalkthroughUiState } from "$lib/stores/walkthrough-ui-state.svelte";
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
  chatStreaming ? "Chat edit in progress — wait for it to finish before regenerating" : undefined,
);
</script>

{#if genActionState}
  <div class="actions-float">
    <div class="actions-row">
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
        onRegenerate={() => regenerateWalkthrough(prId)}
      />

      {#if walkthroughUiState.kind === "streaming" && walkthroughHasNewContentBelow}
        <GlassPill
          onclick={scrollWalkthroughToBottom}
          aria-label="Scroll to newest walkthrough content"
        >
          <ArrowDown size={16} weight="fill" />
          New content
        </GlassPill>
      {/if}

      {#if walkthroughHasRatings}
        <GlassPill
          onclick={scrollWalkthroughToRatings}
          aria-label="Scroll to rating panel"
        >
          <Star size={16} weight="fill" />
          Rating
        </GlassPill>
      {/if}
    </div>
  </div>
{/if}
