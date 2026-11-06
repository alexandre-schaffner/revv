<script lang="ts">
import {
  HUNK_SMELL_META,
  type HunkSmell,
  ISSUE_SEVERITY_LABEL,
  issueResolutionLabel,
  type WalkthroughIssue,
} from "@revv/shared";
import Waveform from "phosphor-svelte/lib/Waveform";
import { type EnterParams, enterOnce } from "$lib/motion";

interface Props {
  issue: WalkthroughIssue;
  clickable?: boolean;
  onclick?: () => void;
  /** The card's one-shot entrance; none when absent. */
  entrance?: EnterParams | undefined;
  stepTag?: string | null;
  /** Smells the first pass flagged on this issue's hunk, before the review ran. */
  firstPassSmells?: readonly HunkSmell[] | undefined;
}

let {
  issue,
  clickable = false,
  onclick,
  entrance,
  stepTag = null,
  firstPassSmells,
}: Props = $props();

const firstPassLabel = $derived(
  firstPassSmells && firstPassSmells.length > 0
    ? `The first pass flagged this hunk: ${firstPassSmells.map((s) => HUNK_SMELL_META[s].label.toLowerCase()).join(", ")}`
    : null,
);

const resolutionLabel = $derived(issueResolutionLabel(issue.resolutionStatus));
const resolved = $derived(resolutionLabel !== null);
</script>

{#if clickable}
	<button
		type="button"
		class="issue-card issue-card--{issue.severity}"
		class:issue-card--resolved={resolved}
		use:enterOnce={entrance}
		{onclick}
	>
		{@render cardContent()}
	</button>
{:else}
	<div
		class="issue-card issue-card--{issue.severity}"
		class:issue-card--resolved={resolved}
		use:enterOnce={entrance}
	>
		{@render cardContent()}
	</div>
{/if}

{#snippet cardContent()}
	<div class="issue-card-body">
		<div class="issue-card-top" class:issue-card-top--tagged={!!stepTag}>
			<span class="issue-card-marks">
				<span class="issue-badge issue-badge--{issue.severity}">
					{ISSUE_SEVERITY_LABEL[issue.severity]}
				</span>
				{#if resolutionLabel}
					<span class="issue-card-resolution-badge">{resolutionLabel}</span>
				{/if}
				{#if firstPassLabel}
					<span class="issue-card-first-pass" role="img" aria-label={firstPassLabel} title={firstPassLabel}>
						<Waveform size={12} weight="bold" />
					</span>
				{/if}
			</span>
			<span class="issue-card-title">{issue.title}</span>
			{#if stepTag}
				<span class="issue-step-tag">{stepTag}</span>
			{/if}
		</div>
		<p class="issue-card-description">{issue.description}</p>
	</div>
{/snippet}

<style>
	.issue-card {
		padding: 10px 14px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--severity-color, transparent) 5%, var(--color-bg-secondary));
		border: 1px solid color-mix(in srgb, var(--severity-color, transparent) 35%, var(--color-border));
		display: flex;
		flex-direction: row;
		align-items: flex-start;
		gap: 10px;
		text-align: left;
		font: inherit;
		color: inherit;
		width: 100%;
		box-sizing: border-box;
		cursor: default;
		/* Its own query container: its width comes from whichever list embeds
		   it, which `.review-content` (the nearest container) doesn't track.
		   `width: 100%` above keeps inline-size containment from collapsing it
		   to zero. No position:fixed descendants live here, so the
		   containing-block side effect is inert. */
		container-type: inline-size;
		container-name: issue-card;
	}

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

	.issue-card--resolved {
		--severity-color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 5%, var(--color-bg-secondary));
	}

	.issue-card-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
		min-width: 0;
	}

	/* Grid, not a wrapping flexbox: with flex, a long title makes the *tag*
	   wrap onto its own line, orphaned. The title's `minmax(0, 1fr)` track
	   wraps inside its column while the badges and the tag stay pinned to the
	   first baseline. */
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

	.issue-card-resolution-badge {
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

	/* Corroboration, not a status: an icon in the card's own tone, quiet
	   enough to skim past and specific enough on hover. */
	.issue-card-first-pass {
		display: inline-flex;
		align-self: center;
		color: color-mix(in srgb, var(--severity-color, var(--color-text-muted)) 70%, var(--color-text-muted));
	}

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

</style>
