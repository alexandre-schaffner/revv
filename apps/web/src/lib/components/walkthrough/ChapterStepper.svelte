<script lang="ts" module>
import type { Snippet } from "svelte";
import type { DotmatrixVariant } from "$lib/components/ui/dotmatrix/index.js";

export interface StepperChapter {
  id: string;
  label: string;
  /** Under the title when the cell isn't active. */
  blurb: string;
  /** Beside the spinner while active, when there are no tool calls to show. */
  activeBlurb: string;
  spinner: DotmatrixVariant;
  /** The section a click scrolls to. */
  targetId: string;
  /** Its section has content, so the cell is a jump once generation is over. */
  available: boolean;
  /** The chapter's own content under its body, active or not. */
  extra?: Snippet | undefined;
  /** Before the jump, e.g. to open a folded target. */
  onjump?: (() => void) | undefined;
}
</script>

<script lang="ts">
import { Dotmatrix } from "$lib/components/ui/dotmatrix/index.js";
import { gsapFadeY, tokens } from "$lib/motion";

/**
 * The walkthrough's chapter index. While generating, the active cell carries
 * a spinner and the agent's latest tool calls, earlier cells read as done and
 * later ones as queued; once over, every chapter with content is a jump to it.
 */
interface Props {
  chapters: readonly StepperChapter[];
  /** The chapter generation is in; earlier cells read as done, later as queued. */
  activeId: string;
  isStreaming: boolean;
  /** The agent's most recent calls in the active chapter, each with a stable ordinal. */
  toolCalls: ReadonlyArray<{ step: { toolName: string; summary: string }; ordinal: number }>;
  onjump: (targetId: string) => void;
}

let { chapters, activeId, isStreaming, toolCalls, onjump }: Props = $props();

const activeIndex = $derived(chapters.findIndex((c) => c.id === activeId));

const TOOL_CALL_ROW_H = 14; // px — 10px font × 1.4 line-height
</script>

<div
	class="chapter-stepper"
	style:--chapter-count={chapters.length}
	role="progressbar"
	aria-label="Walkthrough chapters"
	aria-valuenow={activeIndex + 1}
	aria-valuemin={1}
	aria-valuemax={chapters.length}
>
	{#each chapters as chapter, i (chapter.id)}
		{@const active = isStreaming && i === activeIndex}
		{@const clickable = !active && chapter.available}
		<button
			type="button"
			class={[
				'chapter-cell',
				active && 'chapter-cell--active',
				isStreaming && i < activeIndex && 'chapter-cell--done',
				isStreaming && i > activeIndex && 'chapter-cell--queued',
				!isStreaming && (chapter.available ? 'chapter-cell--available' : 'chapter-cell--unavailable'),
				clickable && 'chapter-cell--clickable',
			]}
			disabled={!clickable}
			aria-label={clickable ? `Jump to ${chapter.label}` : chapter.label}
			onclick={clickable
				? () => {
						chapter.onjump?.();
						onjump(chapter.targetId);
					}
				: undefined}
		>
			<div class="chapter-eyebrow">Step {String(i + 1).padStart(2, '0')}</div>
			{#if active}
				<div class="chapter-active-layout">
					<div class="chapter-title">{chapter.label}</div>
					<div class="chapter-active-row">
						<Dotmatrix variant={chapter.spinner} {active} />
						{#if toolCalls.length > 0}
							<div class="chapter-tool-calls">
								{#each toolCalls.slice(-2) as { step, ordinal }, row (ordinal)}
									<div
										class="chapter-tool-call"
										style="top: {row * TOOL_CALL_ROW_H}px"
										in:gsapFadeY={{ y: TOOL_CALL_ROW_H, duration: tokens.smooth }}
										out:gsapFadeY={{ y: -TOOL_CALL_ROW_H, duration: tokens.quick }}
									>
										<span class="chapter-tool-call-tool">{step.toolName}</span>
										<span class="chapter-tool-call-desc">{step.summary}</span>
									</div>
								{/each}
							</div>
						{:else}
							<span class="chapter-active-blurb">{chapter.activeBlurb}</span>
						{/if}
					</div>
					{#if chapter.extra}
						<div class="chapter-extra">{@render chapter.extra()}</div>
					{/if}
				</div>
			{:else}
				<div class="chapter-title-row">
					<div class="chapter-title">{chapter.label}</div>
				</div>
				<div class="chapter-body">
					<div class="chapter-blurb">{chapter.blurb}</div>
					{#if chapter.extra}
						<div class="chapter-extra">{@render chapter.extra()}</div>
					{/if}
				</div>
			{/if}
		</button>
	{/each}
</div>

<style>
	/* ── Chapters stepper ────────────────────────────────────────────────
	   One cell per chapter, side by side. Active cell: 2px accent top rule, italic
	   serif eyebrow, big serif title, body row of {dot-matrix spinner +
	   "reading" verb + live mono file path}. Past/queued cells: same title
	   with a static blurb under it — no "done" affordance, just absence of
	   the active treatment. */

	.chapter-stepper {
		display: grid;
		grid-template-columns: repeat(var(--chapter-count, 4), minmax(0, 1fr));
		column-gap: 16px;
	}

	.chapter-cell {
		/* Reset button defaults — the cell is rendered as a <button> so it can
		   participate in tab order and fire onclick when clickable. Inheriting
		   the surrounding type styles keeps the visual output identical to the
		   prior <div>-based markup. */
		appearance: none;
		background: transparent;
		border: none;
		border-radius: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		display: block;
		width: 100%;
		/* A <button> centres its content vertically, so a taller neighbour
		   would push this cell's text down. Pin every cell to the top. */
		align-self: start;

		min-width: 0;
		padding: 10px 0 0;
		/* `--color-border` (not `--color-border-subtle`): in dark mode the
		   `subtle` token collapses onto the tertiary surface and the rule
		   becomes invisible. Border is a tier up — visible against
		   `--color-bg-primary` in both light and dark themes. */
		border-top: 2px solid var(--color-border);
		transition: border-color var(--duration-smooth) var(--ease-soft), opacity var(--duration-smooth) var(--ease-soft),
			transform var(--duration-quick) var(--ease-soft), background-color var(--duration-quick) var(--ease-soft);
		cursor: default;
	}

	.chapter-cell:disabled {
		cursor: default;
	}

	.chapter-cell--active {
		border-top-color: var(--color-accent);
	}

	/* Past, but only the heading recedes: the blurb and the chapter's own
	   content (the first pass's tally and ribbon) are results, and stay
	   legible. */
	.chapter-cell--done {
		border-top-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
	}

	.chapter-cell--done :is(.chapter-eyebrow, .chapter-title-row) {
		opacity: 0.5;
		transition: opacity var(--duration-smooth) var(--ease-soft);
	}

	.chapter-cell--queued {
		opacity: 0.35;
	}

	/* ── Navigation mode (post-streaming) ─────────────────────────────────
	   Once generation finishes, the stepper persists as a chapter index for
	   quick jumps to any section. Chapters whose content was written get a
	   highlighted top rule + clickable hover/focus treatment; chapters that
	   never wrote (e.g., generation aborted before Phase D) stay muted. */

	.chapter-cell--available {
		border-top-color: var(--color-accent);
	}

	.chapter-cell--unavailable {
		opacity: 0.35;
	}

	.chapter-cell--clickable {
		cursor: pointer;
	}

	/* Done cells (already-completed phases during streaming) drop to 0.5
	   opacity by default to read as "past." Bump opacity on hover so the
	   click affordance is unambiguous when the user reaches for one. */
	.chapter-cell--clickable.chapter-cell--done:hover :is(.chapter-eyebrow, .chapter-title-row) {
		opacity: 1;
	}

	.chapter-cell--clickable:hover .chapter-title {
		color: var(--color-accent);
	}

	.chapter-cell--clickable:hover .chapter-blurb {
		color: var(--color-text-secondary);
	}

	.chapter-cell--clickable:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.chapter-cell--clickable:active {
		transform: translateY(1px);
	}

	.chapter-eyebrow {
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 11.5px;
		font-weight: 500;
		letter-spacing: 0.3px;
		color: var(--color-text-muted);
		margin-bottom: 2px;
		white-space: nowrap;
		transition: color var(--duration-smooth) var(--ease-soft);
	}

	.chapter-cell--active .chapter-eyebrow,
	.chapter-cell--done .chapter-eyebrow,
	.chapter-cell--available .chapter-eyebrow {
		color: var(--color-accent);
	}

	.chapter-active-layout {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		margin-bottom: 6px;

	}

	/* inactive path only */
	.chapter-title-row {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-bottom: 6px;
		min-width: 0;
	}

	.chapter-title {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 18px;
		font-weight: 500;
		letter-spacing: -0.012em;
		line-height: 1.05;
		color: var(--color-text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition: color var(--duration-smooth) var(--ease-soft);
	}



	.chapter-body {
		min-height: 32px;
	}

	/* A chapter's own content under its body (the first pass's ribbon). */
	.chapter-extra {
		margin-top: 6px;
	}

	.chapter-active-layout > .chapter-extra {
		margin-top: 0;
	}

	.chapter-active-blurb {
		font-variant-numeric: tabular-nums;
	}

	.chapter-active-row {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		color: var(--color-accent);
		min-width: 0;
	}

	.chapter-tool-calls {
		position: relative;
		flex: 1;
		height: 28px; /* 2 × 14px rows, fixed — prevents layout shift during transitions */
		min-width: 0;
		overflow: hidden;
	}

	.chapter-tool-call {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		gap: 6px;
		min-width: 0;
		/* `top` is deliberate over `transform: translateY`: Svelte's `fly` enter
		   transition (used inline) writes inline `transform`, and a base-class
		   transform would compose unpredictably with it. The animated property
		   is bounded to ±14px so the layout cost is trivial. */
		transition: top var(--duration-smooth) var(--ease-standard);
	}

	.chapter-tool-call-tool {
		color: var(--color-accent);
		font-weight: 500;
		flex-shrink: 0;
	}

	.chapter-tool-call-desc {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		color: var(--color-text-muted);
	}

	.chapter-blurb {
		font-size: 10.5px;
		line-height: 1.35;
		color: var(--color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		transition: color var(--duration-smooth) var(--ease-soft);
		text-overflow: ellipsis;
	}
</style>
