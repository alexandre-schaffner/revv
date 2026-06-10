<script lang="ts">
import type { WalkthroughMode } from "@revv/shared";
import ArrowDown from "phosphor-svelte/lib/ArrowDown";
import ArrowUp from "phosphor-svelte/lib/ArrowUp";
import Star from "phosphor-svelte/lib/Star";
import User from "phosphor-svelte/lib/User";
import Users from "phosphor-svelte/lib/Users";
import GenActionBar, { type GenActionState } from "$lib/components/layout/GenActionBar.svelte";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";
import { getCurrentUserLogin } from "$lib/stores/auth.svelte";
import { isChatStreaming } from "$lib/stores/chat.svelte";
import { getSelectedPr } from "$lib/stores/prs.svelte";
import {
  abort as abortWalkthrough,
  generateWalkthrough,
  getPendingAction as getWalkthroughPendingAction,
  getRatings as getWalkthroughRatings,
  getSelectedMode as getWalkthroughSelectedMode,
  getWalkthroughUiState,
  hydrateFromCache,
  regenerate as regenerateWalkthrough,
  resume as resumeWalkthrough,
  setSelectedMode as setWalkthroughSelectedMode,
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
const pr = $derived(getSelectedPr());
const currentUserLogin = $derived(getCurrentUserLogin());
const defaultMode: WalkthroughMode = $derived(
  pr?.authorLogin && currentUserLogin && pr.authorLogin === currentUserLogin
    ? "author"
    : "reviewer",
);
const selectedMode = $derived(getWalkthroughSelectedMode(prId, defaultMode));

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
const modeDisabled = $derived(
  chatStreaming || walkthroughUiState.kind === "streaming" || walkthroughPendingAction !== null,
);

function selectMode(mode: WalkthroughMode): void {
  if (modeDisabled || mode === selectedMode) return;
  setWalkthroughSelectedMode(prId, mode);
  void hydrateFromCache(prId, { mode, activate: false });
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
        <ArrowUp size={16} weight="regular" />
      </GlassPill>

      <GenActionBar
        uiState={genActionState}
        pendingAction={combinedPendingAction}
        disabledTitle={combinedDisabledTitle}
        onStop={() => abortWalkthrough(prId)}
        onResume={() => resumeWalkthrough(prId, selectedMode)}
        onGenerate={() => generateWalkthrough(prId, selectedMode)}
        onRegenerate={() => regenerateWalkthrough(prId, selectedMode)}
      />

      <div class="mode-switch" role="group" aria-label="Walkthrough mode">
        <button
          type="button"
          class:active={selectedMode === 'reviewer'}
          disabled={modeDisabled}
          title="Review someone else's PR"
          aria-pressed={selectedMode === 'reviewer'}
          onclick={() => selectMode('reviewer')}
        >
          <Users size={15} weight="regular" />
          Reviewer
        </button>
        <button
          type="button"
          class:active={selectedMode === 'author'}
          disabled={modeDisabled}
          title="Self-review your own PR"
          aria-pressed={selectedMode === 'author'}
          onclick={() => selectMode('author')}
        >
          <User size={15} weight="regular" />
          Self-review
        </button>
      </div>

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

  .mode-switch {
    display: inline-grid;
    grid-template-columns: minmax(92px, auto) minmax(112px, auto);
    align-items: center;
    min-height: 34px;
    padding: 3px;
    border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-bg-elevated) 88%, transparent);
    box-shadow: var(--shadow-island);
  }

  .mode-switch button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--color-text-muted);
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }

  .mode-switch button.active {
    background: var(--color-bg);
    color: var(--color-text-primary);
    box-shadow: 0 1px 4px color-mix(in srgb, var(--color-text-primary) 14%, transparent);
  }

  .mode-switch button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
