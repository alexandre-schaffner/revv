<script module lang="ts">
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
import type { GenActionCopy, GenActionState, GenPendingAction } from "./gen-action";

// Renders a pill only for the actions its caller supplies.

interface Props {
  uiState: GenActionState;
  pendingAction: GenPendingAction | null;
  /** Something outside the bar (e.g. a streaming chat) blocks the actions; this is why. */
  disabledTitle?: string | undefined;
  copy: GenActionCopy;
  onStop: () => void;
  /** Resume after a stop, Retry after an error. Absent: those states offer Regenerate alone. */
  onResume?: (() => void) | undefined;
  /** `perspective` is the caret's pick; absent from the main segment. Absent: Generate regenerates. */
  onGenerate?: ((perspective?: T) => void) | undefined;
  onRegenerate: (perspective?: T) => void;
  /** Absent: a complete or stale document offers its main pill alone. */
  onRegenerateFromScratch?: ((perspective?: T) => void) | undefined;
  /** Puts a perspective caret on every pill that starts a fresh run
   *  (Generate, From scratch, Regenerate after a stop). Absent → plain pills
   *  (recaps). */
  perspective?: GenPerspective<T> | undefined;
}

let {
  uiState,
  pendingAction,
  disabledTitle,
  copy,
  onStop,
  onResume,
  onGenerate,
  onRegenerate,
  onRegenerateFromScratch,
  perspective,
}: Props = $props();

const PENDING_TITLE: Record<GenPendingAction, string> = {
  start: "Starting…",
  regenerate: "Regenerating…",
  resume: "Resuming…",
  stop: "Stopping…",
};

const destructiveDisabled = $derived(pendingAction !== null || disabledTitle !== undefined);
const destructiveTitle = $derived(
  disabledTitle ?? (pendingAction ? PENDING_TITLE[pendingAction] : undefined),
);

function generate(next?: T): void {
  if (onGenerate) onGenerate(next);
  else onRegenerate(next);
}

/** A run in another perspective is always a fresh one. */
function regenerateFresh(next?: T): void {
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
	{@render perspectiveRows(close, regenerateFresh)}
{/snippet}

{#snippet fromScratch(which: "complete" | "stale")}
	{#if onRegenerateFromScratch}
		<GlassSplitPill
			disabled={destructiveDisabled}
			title={destructiveTitle ?? copy.fromScratch?.[which]}
			onclick={() => regenerateFresh()}
			menuLabel="Start from scratch in another perspective"
			menu={perspective ? fromScratchMenu : undefined}
		>
			<ArrowCounterClockwise size={16} />
			From scratch
		</GlassSplitPill>
	{/if}
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
  When `uiState.kind` flips, Svelte mounts the new branch while the old one is
  still animating out. `.gen-slot` stacks both in one grid cell, and `in:`
  waits out the `out:` duration, so the pills never sit side by side or
  crossfade in place.
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
        title={destructiveTitle ?? uiState.label}
        onclick={() => generate()}
        menuLabel="Generate in another perspective"
        menu={perspective ? generateMenu : undefined}
      >
        <PenNib size={16} />
        {uiState.label}
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
      {#if onResume}
        <GlassPill
          disabled={destructiveDisabled}
          title={destructiveTitle ?? "Resume generation from where it stopped"}
          onclick={onResume}
          aria-label="Resume generation"
        >
          <Play size={16} fill="currentColor" />
          Resume
        </GlassPill>
      {/if}
      {@render replaceDraft()}
    {:else if uiState.kind === "error"}
      {#if onResume}
        <GlassPill
          disabled={destructiveDisabled}
          title={destructiveTitle ?? "Retry generation after error"}
          onclick={onResume}
          aria-label="Retry generation"
        >
          <ArrowCounterClockwise size={16} />
          Retry
        </GlassPill>
      {/if}
      {@render replaceDraft()}
    {:else if uiState.kind === "complete"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? copy.regenerate}
        onclick={() => onRegenerate()}
      >
        <ArrowsClockwise size={16} />
        Regenerate
      </GlassPill>
      {@render fromScratch("complete")}
    {:else if uiState.kind === "stale"}
      <GlassPill
        disabled={destructiveDisabled}
        title={destructiveTitle ?? copy.stale}
        onclick={() => onRegenerate()}
      >
        <ArrowsClockwise size={16} />
        {uiState.label}
      </GlassPill>
      {@render fromScratch("stale")}
    {/if}
    </span>
  {/key}
</span>

<style>
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
  .gen-branch {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-island);
  }
</style>
