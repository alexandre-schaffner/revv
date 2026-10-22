<script module lang="ts">
/** Normalised lifecycle state for any generation pipeline
 *  (walkthrough, recap, etc.). */
export type GenActionState =
  | { kind: "empty"; label?: string }
  | { kind: "streaming" }
  | { kind: "resumable" }
  | { kind: "error" }
  | { kind: "complete" }
  | { kind: "stale"; label?: string };

/** One perspective a fresh run can be written from (walkthrough: reviewer /
 *  author). */
interface GenPerspectiveOption<P extends string> {
  readonly value: P;
  readonly label: string;
  readonly description: string;
}

/** The perspective the main segments use, and the menu the caret offers. */
interface GenPerspective<P extends string> {
  readonly value: P;
  readonly options: readonly GenPerspectiveOption<P>[];
}
</script>

<script lang="ts" generics="T extends string">
import ArrowCounterClockwise from "phosphor-svelte/lib/ArrowCounterClockwise";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import Check from "phosphor-svelte/lib/Check";
import PenNib from "phosphor-svelte/lib/PenNib";
import Play from "phosphor-svelte/lib/Play";
import StopCircle from "phosphor-svelte/lib/StopCircle";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import GlassSplitPill from "$lib/components/ui/glass-pill/GlassSplitPill.svelte";
import { gsapFade, gsapFadeY, tokens } from "$lib/motion";

interface Props {
  uiState: GenActionState;
  /** In-flight destructive action (regenerate, resume, stop). */
  pendingAction: string | null;
  /** Optional override for the disabled-state tooltip.
   *  Use when an external condition (e.g. chat streaming) blocks actions. */
  disabledTitle?: string | undefined;
  onStop?: () => void;
  onResume?: () => void;
  /** `perspective` is the caret's pick; absent from the main segment. */
  onGenerate?: (perspective?: T) => void;
  onRegenerate: (perspective?: T) => void;
  onRegenerateFromScratch?: (perspective?: T) => void;
  /** Puts a perspective caret on every pill that starts a fresh run
   *  (Generate, From scratch, Regenerate after a stop). Absent → plain pills
   *  (recaps). */
  perspective?: GenPerspective<T> | undefined;
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
  perspective,
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

function generate(next?: T): void {
  if (onGenerate) onGenerate(next);
  else onRegenerate(next);
}

/** A run in another perspective is always a fresh one. */
function regenerateFromScratch(next?: T): void {
  if (onRegenerateFromScratch) onRegenerateFromScratch(next);
  else onRegenerate(next);
}
</script>

{#snippet perspectiveRows(close: () => void, run: (next: T) => void)}
	{#if perspective}
		<p class="px-2 pt-1.5 pb-1 text-xs font-semibold text-text-secondary">Perspective</p>
		{#each perspective.options as opt (opt.value)}
			<button
				type="button"
				class="flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-bg-tertiary focus-visible:bg-bg-tertiary focus-visible:outline-none"
				onclick={() => {
					close();
					run(opt.value);
				}}
			>
				<span class="flex min-w-0 flex-1 flex-col gap-0.5">
					<span class="text-xs font-medium text-text-primary">{opt.label}</span>
					<span class="text-xs text-text-muted">{opt.description}</span>
				</span>
				{#if opt.value === perspective.value}
					<Check size={12} class="mt-0.5 shrink-0 text-accent" />
				{/if}
			</button>
		{/each}
	{/if}
{/snippet}

{#snippet generateMenu(close: () => void)}
	{@render perspectiveRows(close, generate)}
{/snippet}

{#snippet fromScratchMenu(close: () => void)}
	{@render perspectiveRows(close, regenerateFromScratch)}
{/snippet}

{#snippet fromScratch(title: string)}
	<GlassSplitPill
		disabled={destructiveDisabled}
		title={destructiveTitle ?? title}
		onclick={() => regenerateFromScratch()}
		menuLabel="Start from scratch in another perspective"
		menu={perspective ? fromScratchMenu : undefined}
	>
		<ArrowCounterClockwise size={16} />
		From scratch
	</GlassSplitPill>
{/snippet}

<!-- After a stop or an error, Regenerate replaces the draft; its caret starts
     the replacement in another perspective. -->
{#snippet replaceDraft()}
	<GlassSplitPill
		disabled={destructiveDisabled}
		title={destructiveTitle ?? "Generate a fresh version (the current draft will be replaced)"}
		onclick={() => onRegenerate()}
		menuLabel="Regenerate in another perspective"
		menu={perspective ? fromScratchMenu : undefined}
	>
		<ArrowsClockwise size={16} />
		Regenerate
	</GlassSplitPill>
{/snippet}

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
      <GlassSplitPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? uiState.label ?? "Generate walkthrough"}
        onclick={() => generate()}
        menuLabel="Generate in another perspective"
        menu={perspective ? generateMenu : undefined}
      >
        <PenNib size={16} />
        {uiState.label ?? "Generate walkthrough"}
      </GlassSplitPill>
    {:else if uiState.kind === "streaming"}
      <GlassPill
        variant="danger"
        onclick={onStop}
        disabled={pendingAction === "stop"}
        title={pendingAction === "stop" ? "Stopping…" : "Stop generation"}
      >
        <StopCircle size={16} />
        {pendingAction === "stop" ? "Stopping…" : "Stop generation"}
      </GlassPill>
    {:else if uiState.kind === "resumable"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Resume generation from where it stopped"}
        onclick={onResume}
        aria-label="Resume generation"
      >
        <Play size={16} fill="currentColor" />
        Resume
      </GlassPill>
      {@render replaceDraft()}
    {:else if uiState.kind === "error"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Retry generation after error"}
        onclick={onResume}
        aria-label="Retry generation"
      >
        <ArrowCounterClockwise size={16} />
        Retry
      </GlassPill>
      {@render replaceDraft()}
    {:else if uiState.kind === "complete"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Refresh this report using the current review as context"}
        onclick={() => onRegenerate()}
      >
        <ArrowsClockwise size={16} />
        Regenerate
      </GlassPill>
      {@render fromScratch("Generate a fresh review without using the prior report")}
    {:else if uiState.kind === "stale"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? "Review only what changed since the last reviewed commit"}
        onclick={() => onRegenerate()}
      >
        <ArrowsClockwise size={16} />
        {uiState.label ?? "Review new commits"}
      </GlassPill>
      {@render fromScratch("Generate a fresh review for the latest commit")}
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
