<script lang="ts">
import type { WalkthroughIssue } from "@revv/shared";
import { Checkbox } from "$lib/components/ui/checkbox";
import FileBadge from "$lib/components/ui/FileBadge.svelte";

interface Props {
  issue: WalkthroughIssue;
  clickable?: boolean;
  onclick?: () => void;
  checkable?: boolean;
  checked?: boolean;
  disabled?: boolean;
  oncheck?: (checked: boolean) => void;
  submitted?: boolean;
  animationDelay?: string;
  /**
   * When true, suppress the entrance animation entirely. Used on tab
   * revisits where the card has already animated once — browsers otherwise
   * restart CSS animations when a subtree re-enters the render tree after
   * `display: none`.
   */
  noAnim?: boolean;
  onfileclick?: (filePath: string, line: number) => void;
  stepTag?: string | null;
  hideFileBadge?: boolean;
}

let {
  issue,
  clickable = false,
  onclick,
  checkable = false,
  checked = false,
  disabled = false,
  oncheck,
  submitted = false,
  animationDelay = "0ms",
  noAnim = false,
  onfileclick,
  stepTag = null,
  hideFileBadge = false,
}: Props = $props();

const severityLabels: Record<string, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

// Once the entrance animation completes (or if the parent tells us to skip
// it), lock the card into its final visual state by applying `--no-anim`.
// Without this, browsers restart CSS animations on elements that re-enter
// the render tree after `display: none` — so every tab switch back to the
// Walkthrough would replay the card's fade-in.
let animEnded = $state(false);
const animLocked = $derived(noAnim || animEnded);

function onAnimEnd(event: AnimationEvent): void {
  // Only react to the card's own animation, not descendants bubbling up.
  if (event.target !== event.currentTarget) return;
  if (event.animationName === "issue-card-enter") {
    animEnded = true;
  }
}
</script>

{#if clickable}
	<button
		type="button"
		class="issue-card issue-card--{issue.severity}"
		class:issue-card--submitted={submitted}
		class:issue-card--no-anim={animLocked}
		style:--issue-delay={animationDelay}
		onanimationend={onAnimEnd}
		{onclick}
	>
		{@render cardContent()}
	</button>
{:else if checkable}
	<!-- The Checkbox inside is the real interactive control (keyboard-accessible);
	     this label is just a wider click target. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<label
		class="issue-card issue-card--{issue.severity}"
		class:issue-card--submitted={submitted}
		class:issue-card--checked={checked}
		class:issue-card--no-anim={animLocked}
		style:--issue-delay={animationDelay}
		onanimationend={onAnimEnd}
		onclick={(e) => {
			// The bits-ui Checkbox is a button, not an input, so the native
			// label→input forward we used to rely on no longer fires. Forward
			// here, but skip clicks that already hit the checkbox itself so
			// we don't toggle twice.
			if (submitted || disabled) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest('[data-slot="checkbox"]')) return;
			oncheck?.(!checked);
		}}
	>
		{@render cardContent()}
	</label>
{:else}
	<div
		class="issue-card issue-card--{issue.severity}"
		class:issue-card--submitted={submitted}
		class:issue-card--no-anim={animLocked}
		style:--issue-delay={animationDelay}
		onanimationend={onAnimEnd}
	>
		{@render cardContent()}
	</div>
{/if}

{#snippet cardContent()}
	{#if checkable}
		<Checkbox
			class="issue-card-checkbox"
			aria-label="Select issue"
			{checked}
			{disabled}
			onCheckedChange={(v) => oncheck?.(v === true)}
		/>
	{/if}
	<div class="issue-card-body">
		<!-- Three grid slots: marks / title / step tag. The badges are wrapped in
		     a single `.issue-card-marks` cell so the row stays exactly three
		     columns whether or not the Posted badge is present — see the grid
		     rules in the stylesheet for why that matters. -->
		<div class="issue-card-top" class:issue-card-top--tagged={!!stepTag}>
			<span class="issue-card-marks">
				<span class="issue-badge issue-badge--{issue.severity}">
					{severityLabels[issue.severity] ?? issue.severity}
				</span>
				{#if submitted}
					<span class="issue-card-posted-badge">Posted</span>
				{/if}
			</span>
			<span class="issue-card-title">{issue.title}</span>
			{#if stepTag}
				<span class="issue-step-tag">{stepTag}</span>
			{/if}
		</div>
		{#if issue.filePath && !hideFileBadge}
			<div
				class="issue-card-location"
				onclick={(e) => e.stopPropagation()}
				role="presentation"
			>
				<FileBadge
					filePath={issue.filePath}
					startLine={issue.startLine}
					endLine={issue.endLine}
					onclick={onfileclick && issue.filePath ? () => onfileclick(issue.filePath as string, issue.startLine ?? 1) : undefined}
				/>
			</div>
		{/if}
		<p class="issue-card-description">{issue.description}</p>
	</div>
{/snippet}

<style>
	/* ── Base card ──────────────────────────────────────────────────── */
	.issue-card {
		padding: 10px 14px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--severity-color, transparent) 5%, var(--color-bg-secondary));
		border: 1px solid color-mix(in srgb, var(--severity-color, transparent) 35%, var(--color-border));
		display: flex;
		flex-direction: row;
		align-items: flex-start;
		gap: 10px;
		animation: issue-card-enter var(--duration-ceremonial-medium) var(--ease-standard) both;
		animation-delay: var(--issue-delay, 0ms);
		text-align: left;
		font: inherit;
		color: inherit;
		width: 100%;
		box-sizing: border-box;
		cursor: default;
		/* The card is its own query container: its width is set by whichever
		   list embeds it (the walkthrough content column caps at 820px, the
		   per-file list is the diff pane minus 64px), and neither tracks
		   `.review-content` — the nearest ancestor container — closely enough
		   to drive the header layout. `width: 100%` above is what keeps
		   inline-size containment from collapsing the card to zero intrinsic
		   width. No positioned-fixed descendants live in here, so the
		   containing-block side effect is inert. */
		container-type: inline-size;
		container-name: issue-card;
	}

	/* Suppress the entrance animation on tab revisits. Browsers restart CSS
	   animations when an element re-enters the render tree after `display:
	   none`, which would otherwise replay issue-card-enter on every hop back
	   to the Walkthrough tab. */
	.issue-card--no-anim {
		animation: none;
		opacity: 1;
	}

	/* Severity left-border + hover shadow color */
.issue-card--info {
    --severity-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-secondary));
}
.issue-card--warning {
    --severity-color: var(--color-warning);
    background: color-mix(in srgb, var(--color-warning) 4%, var(--color-bg-secondary));
}
.issue-card--critical {
    --severity-color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 4%, var(--color-bg-secondary));
}

	/* ── Clickable (button) variant ─────────────────────────────────── */
	button.issue-card {
		cursor: pointer;
		transition:
			transform var(--duration-snap) var(--ease-soft),
			border-color var(--duration-snap) var(--ease-soft),
			box-shadow var(--duration-snap) var(--ease-soft);
	}

	button.issue-card:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--severity-color, var(--color-accent)) 50%, var(--color-border));
		box-shadow: 0 2px 8px color-mix(in srgb, var(--severity-color, var(--color-text-primary)) 12%, transparent);
	}

	button.issue-card:hover .issue-step-tag {
		color: var(--severity-color, var(--color-accent));
	}

	button.issue-card:active {
		transform: translateY(0);
		box-shadow: none;
	}

	button.issue-card:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	/* ── Checkable (label) variant ──────────────────────────────────── */
	label.issue-card {
		cursor: pointer;
		transition:
			border-color var(--duration-snap) var(--ease-soft),
			background var(--duration-snap) var(--ease-soft);
	}

	.issue-card--checked {
		border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
		background: color-mix(in srgb, var(--color-accent) 6%, var(--color-bg-secondary));
	}

	/* When severity AND checked, blend both bg tints */
	.issue-card--info.issue-card--checked {
		background: color-mix(
			in srgb,
			var(--color-accent) 8%,
			color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-secondary))
		);
	}
	.issue-card--warning.issue-card--checked {
		background: color-mix(
			in srgb,
			var(--color-accent) 6%,
			color-mix(in srgb, var(--color-warning) 4%, var(--color-bg-secondary))
		);
	}
	.issue-card--critical.issue-card--checked {
		background: color-mix(
			in srgb,
			var(--color-accent) 6%,
			color-mix(in srgb, var(--color-danger) 4%, var(--color-bg-secondary))
		);
	}

	/* ── Submitted state ─────────────────────────────────────────────── */
	.issue-card--submitted {
		opacity: 0.55;
	}

	/* ── Checkbox ────────────────────────────────────────────────────── */
	:global(.issue-card-checkbox) {
		margin-top: 2px;
	}

	/* ── Body ────────────────────────────────────────────────────────── */
	.issue-card-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
		min-width: 0;
	}

	/* Header row. A wrapping flexbox is wrong here: the title is a single
	   flex item with no room to shrink, so as soon as badge + title + tag
	   exceed the card the *tag* is what wraps — landing on its own line,
	   pushed right by `margin-left: auto`, floating between the title and
	   the description with nothing to anchor it. That happens at every card
	   width, including the 820px maximum, whenever a title runs long.

	   Grid instead: the title owns a `minmax(0, 1fr)` track so it wraps
	   inside its own column while the badges and the tag stay pinned to the
	   first baseline. Nothing ever orphans. */
	.issue-card-top {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: baseline;
		column-gap: 8px;
		row-gap: 4px;
	}

	/* Third track only when there's a tag to put in it — an empty `auto`
	   track still costs its `column-gap`, i.e. dead space on the right. */
	.issue-card-top--tagged {
		grid-template-columns: auto minmax(0, 1fr) auto;
	}

	.issue-card-marks {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	/* Below this width the side-by-side title column gets too narrow to read
	   (a 360px card leaves it ~170px), so the tag moves up beside the badges
	   and the title takes the full width underneath. */
	@container issue-card (max-width: 420px) {
		.issue-card-top--tagged {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.issue-card-top--tagged .issue-card-marks {
			grid-column: 1;
			grid-row: 1;
		}
		.issue-card-top--tagged .issue-step-tag {
			grid-column: 2;
			grid-row: 1;
		}
		.issue-card-top--tagged .issue-card-title {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}

	.issue-card-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
		line-height: 1.4;
		min-width: 0;
		/* `anywhere` rather than `break-word` so the title's min-content size
		   shrinks too — otherwise a long unbreakable token (a path, a symbol
		   name) widens the 1fr track and overflows the card. */
		overflow-wrap: anywhere;
	}

	.issue-card-description {
		font-size: 12px;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 0;
		overflow-wrap: anywhere;
	}

	.issue-card-location {
		display: flex;
		align-items: center;
		gap: 2px;
		font-family: var(--font-mono, monospace);
	}

	/* ── Step tag ────────────────────────────────────────────────────── */
	.issue-step-tag {
		justify-self: end;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--color-bg-tertiary);
		white-space: nowrap;
		transition: color var(--duration-snap) var(--ease-soft);
	}

	/* ── Posted badge ─────────────────────────────────────────────────── */
	.issue-card-posted-badge {
		display: inline-flex;
		align-items: center;
		border-radius: 9999px;
		padding: 1px 7px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		flex-shrink: 0;
		background: color-mix(in srgb, var(--color-success) 15%, transparent);
		color: var(--color-success);
		border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
	}

	/* ── Severity badge ──────────────────────────────────────────────── */
	.issue-badge {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 7px;
		border-radius: 9999px;
		border: 1px solid transparent;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.issue-badge--info {
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent-hover);
		border-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
	}

	.issue-badge--warning {
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
		color: var(--color-warning);
		border-color: color-mix(in srgb, var(--color-warning) 30%, transparent);
	}

	.issue-badge--critical {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
		border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
	}

	/* ── Animation ───────────────────────────────────────────────────── */
	@keyframes issue-card-enter {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.issue-card {
			animation-duration: 0.01ms !important;
			animation-delay: 0ms !important;
		}
		button.issue-card,
		label.issue-card {
			transition: none !important;
		}
		button.issue-card:hover {
			transform: none;
		}
	}
</style>
