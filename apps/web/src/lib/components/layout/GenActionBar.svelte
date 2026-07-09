<script lang="ts">
import RotateCcw from "phosphor-svelte/lib/ArrowCounterClockwise";
import RefreshCw from "phosphor-svelte/lib/ArrowsClockwise";
import Play from "phosphor-svelte/lib/Play";
import Sparkle from "phosphor-svelte/lib/Sparkle";
import StopCircle from "phosphor-svelte/lib/StopCircle";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";

/** Normalised lifecycle state for any generation pipeline
 *  (walkthrough, recap, etc.). */
export type GenActionState =
  | { kind: "empty"; label?: string }
  | { kind: "streaming" }
  | { kind: "resumable" }
  | { kind: "error" }
  | { kind: "complete" }
  | { kind: "stale"; label?: string };

interface Props {
  uiState: GenActionState;
  /** In-flight destructive action (regenerate, resume, stop). */
  pendingAction: string | null;
  /** Optional override for the disabled-state tooltip.
   *  Use when an external condition (e.g. chat streaming) blocks actions. */
  disabledTitle?: string | undefined;
  onStop?: () => void;
  onResume?: () => void;
  onGenerate?: () => void;
  onRegenerate: () => void;
  onRegenerateFromScratch?: () => void;
}

let {
  uiState,
  pendingAction,
  disabledTitle,
  onStop,
  onResume,
  onGenerate,
  onRegenerate,
  onRegenerateFromScratch,
}: Props = $props();

const destructiveDisabled = $derived(pendingAction !== null);
const destructiveTitle = $derived(
  disabledTitle ??
    (pendingAction === "regenerate"
      ? "Regenerating…"
      : pendingAction === "resume"
        ? "Resuming…"
        : pendingAction === "stop"
          ? "Stopping…"
          : pendingAction === "start"
            ? "Starting…"
            : undefined),
);
</script>

<!--
  Keyed wrapper: when `uiState.kind` flips (e.g. empty → streaming), Svelte
  mounts the new branch *while* the old branch is still animating out. We
  need two pieces to keep that swap glitch-free:
    1. `.gen-slot` is a 1×1 grid; both branches occupy `1/1` and stack on
       top of each other instead of sitting side-by-side in `.actions-row`.
    2. The `in:` is delayed by the `out:` duration so the new pill fades
       in only after the old one has fully faded out — no crossfade at
       the same position.
-->
<span class="gen-slot">
  {#key uiState.kind}
    <span
      class="gen-branch"
      in:gsapFadeY={{ duration: tokens.snap, y: 2, delay: tokens.instant }}
      out:gsapFade={{ duration: tokens.instant }}
    >
    {#if uiState.kind === "empty"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Generate walkthrough"}
        onclick={onGenerate ?? onRegenerate}
      >
        <Sparkle size={16} weight="fill" />
        {uiState.label ?? "Generate walkthrough"}
      </GlassPill>
    {:else if uiState.kind === "streaming"}
      <GlassPill
        variant="danger"
        onclick={onStop}
        disabled={pendingAction === "stop"}
        title={pendingAction === "stop" ? "Stopping…" : "Stop generation"}
      >
        <StopCircle size={16} weight="fill" />
        {pendingAction === "stop" ? "Stopping…" : "Stop generation"}
      </GlassPill>
    {:else if uiState.kind === "resumable"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Resume generation from where it stopped"}
        onclick={onResume}
        aria-label="Resume generation"
      >
        <Play size={16} weight="fill" fill="currentColor" />
        Resume
      </GlassPill>
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Generate a fresh version (the current draft will be replaced)"}
        onclick={onRegenerate}
      >
        <RefreshCw size={16} weight="fill" />
        Regenerate
      </GlassPill>
    {:else if uiState.kind === "error"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Retry generation after error"}
        onclick={onResume}
        aria-label="Retry generation"
      >
        <RotateCcw size={16} weight="fill" />
        Retry
      </GlassPill>
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Generate a fresh version (the current draft will be replaced)"}
        onclick={onRegenerate}
      >
        <RefreshCw size={16} weight="fill" />
        Regenerate
      </GlassPill>
    {:else if uiState.kind === "complete"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Refresh this report using the current review as context"}
        onclick={onRegenerate}
      >
        <RefreshCw size={16} weight="fill" />
        Regenerate
      </GlassPill>
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Generate a fresh review without using the prior report"}
        onclick={onRegenerateFromScratch ?? onRegenerate}
      >
        <RotateCcw size={16} weight="fill" />
        From scratch
      </GlassPill>
    {:else if uiState.kind === "stale"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Review only what changed since the last reviewed commit"}
        onclick={onRegenerate}
      >
        <RefreshCw size={16} weight="fill" />
        {uiState.label ?? "Review new commits"}
      </GlassPill>
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Generate a fresh review for the latest commit"}
        onclick={onRegenerateFromScratch ?? onRegenerate}
      >
        <RotateCcw size={16} weight="fill" />
        From scratch
      </GlassPill>
    {/if}
    </span>
  {/key}
</span>

<style>
  /* 1×1 grid: both keyed branches land in row/column 1, so the old
     fading-out branch and the freshly-mounted next branch stack on top
     of each other rather than briefly sitting side-by-side as siblings
     in `.actions-row` (which is what caused the Stop+Regenerate flash). */
  .gen-slot {
    display: inline-grid;
    grid-template-columns: auto;
    grid-template-rows: auto;
    align-items: center;
    justify-items: start;
  }
  .gen-slot > .gen-branch {
    grid-column: 1;
    grid-row: 1;
  }
  /* `inline-flex` so the wrapper participates in the parent's flex gap;
     `gap` here matches `.actions-row` so multi-pill branches (resumable,
     error) keep their inner rhythm. */
  .gen-branch {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-island);
  }
</style>
