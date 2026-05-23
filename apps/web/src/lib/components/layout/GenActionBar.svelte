<script lang="ts">
import RotateCcw from "phosphor-svelte/lib/ArrowCounterClockwise";
import RefreshCw from "phosphor-svelte/lib/ArrowsClockwise";
import Play from "phosphor-svelte/lib/Play";
import Sparkle from "phosphor-svelte/lib/Sparkle";
import StopCircle from "phosphor-svelte/lib/StopCircle";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";

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
}

let { uiState, pendingAction, disabledTitle, onStop, onResume, onGenerate, onRegenerate }: Props =
  $props();

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
    title={destructiveTitle ?? "Generate a fresh version"}
    onclick={onRegenerate}
  >
    <RefreshCw size={16} weight="fill" />
    Regenerate
  </GlassPill>
{:else if uiState.kind === "stale"}
  <GlassPill
    disabled={destructiveDisabled}
    title={destructiveTitle ?? "Regenerate for the latest version"}
    onclick={onRegenerate}
  >
    <RefreshCw size={16} weight="fill" />
    {uiState.label ?? "Regenerate for latest"}
  </GlassPill>
{/if}
