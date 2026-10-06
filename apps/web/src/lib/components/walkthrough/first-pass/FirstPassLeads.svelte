<script lang="ts">
import { HUNK_SMELL_META, HUNK_SMELLS, type HunkSmell, hunkKey } from "@revv/shared";
import Waveform from "phosphor-svelte/lib/Waveform";
import {
  hunkRangeLabel,
  type LeadOutcome,
  leadOutcomeNote,
  smellTone,
  type UnraisedLead,
} from "$lib/utils/hunk-scan";
import FoldedDisclosure from "../FoldedDisclosure.svelte";
import { SMELL_ICONS } from "./smell-icons";

/**
 * The first-pass leads the review didn't raise, in the same fold as the
 * low-signal issues (or all of them, before any walkthrough exists). Leads it
 * did raise carry a mark on their issue card instead, so nothing here repeats
 * the list above. One row: the toggle, then a per-smell tally whose items
 * double as filters (picking one opens the list). Open, each lead is a row
 * that jumps to its hunk.
 */
interface Props {
  leads: UnraisedLead[];
  /** Why the scan didn't cover the whole diff, when it didn't. */
  note: string | null;
  /** Generation is over, so an unraised lead is final. */
  isComplete: boolean;
  /** A walkthrough exists to have raised them. False before Generate: every lead is just a lead. */
  reviewed?: boolean;
  open?: boolean;
  onjump: (filePath: string, line: number) => void;
}

let { leads, note, isComplete, reviewed = true, open = $bindable(false), onjump }: Props = $props();

/** Rows shown before "Show all". */
const PREVIEW = 12;

const tally = $derived(
  HUNK_SMELLS.flatMap((smell) => {
    const n = leads.filter((l) => l.smells.some((s) => s.smell === smell)).length;
    return n > 0 ? [{ smell, n }] : [];
  }).sort(
    (a, b) =>
      Number(smellTone(b.smell) === "danger") - Number(smellTone(a.smell) === "danger") ||
      b.n - a.n,
  ),
);

let filter = $state<HunkSmell | null>(null);
let showAll = $state(false);

const filtered = $derived(
  filter === null ? leads : leads.filter((l) => l.smells.some((s) => s.smell === filter)),
);
const visible = $derived(showAll ? filtered : filtered.slice(0, PREVIEW));

function pick(smell: HunkSmell): void {
  const next = open && filter === smell ? null : smell;
  filter = next;
  showAll = false;
  open = true;
}

/** The short status a row carries; empty where the header already says it. */
const OUTCOME_LABELS: Record<LeadOutcome["kind"], string> = {
  confirmed: "",
  withdrawn: "Withdrawn",
  rejected: "Ruled out",
  unchecked: "No verdict",
  not_raised: "",
  not_sent: "Not sent",
  pending: "",
};

function splitPath(filePath: string): { dir: string; name: string } {
  const slash = filePath.lastIndexOf("/");
  return slash < 0
    ? { dir: "", name: filePath }
    : { dir: filePath.slice(0, slash + 1), name: filePath.slice(slash + 1) };
}
</script>

{#if leads.length > 0 || note}
	<FoldedDisclosure
		bind:open
		ontoggle={(isOpen) => {
			if (!isOpen) filter = null;
		}}
	>
		{#snippet label()}
			<Waveform size={12} weight="bold" />
			<span class="leads-toggle-label">
				{#if leads.length === 0}
					First pass incomplete
				{:else}
					{leads.length} first-pass lead{leads.length !== 1 ? 's' : ''}
					{#if reviewed}{isComplete ? 'the review didn’t raise' : 'not raised yet'}{/if}
				{/if}
			</span>
		{/snippet}
		{#snippet aside()}
			{#if tally.length > 0}
				<div class="leads-tally" role="group" aria-label="Filter leads by smell">
					{#each tally as { smell, n } (smell)}
						{@const Icon = SMELL_ICONS[smell]}
						{@const meta = HUNK_SMELL_META[smell]}
						<button
							type="button"
							class="leads-tally-item leads-tone--{smellTone(smell)}"
							aria-pressed={open && filter === smell}
							aria-label="{meta.label}, {n}"
							title="{meta.label}: {meta.description}"
							onclick={() => pick(smell)}
						>
							<Icon size={11} weight="bold" />{n}
						</button>
					{/each}
				</div>
			{/if}
		{/snippet}

		<div class="leads-body">
			{#if note}
				<p class="leads-note">{note}</p>
			{/if}

			{#if filter}
				<p class="leads-note">
					<span class="leads-note-label">{HUNK_SMELL_META[filter].label}</span>
					{HUNK_SMELL_META[filter].description}
				</p>
			{/if}

			{#if filtered.length > 0}
				<ul class="leads-list">
					{#each visible as lead (hunkKey(lead.row))}
						{@const path = splitPath(lead.row.filePath)}
						{@const range = hunkRangeLabel(lead.row)}
						{@const top = lead.smells[0]}
						{@const status = reviewed ? OUTCOME_LABELS[lead.outcome.kind] : ''}
						{@const outcomeNote = reviewed ? leadOutcomeNote(lead.outcome) : null}
						<li>
							<button
								type="button"
								class="lead"
								class:lead--not-sent={reviewed && lead.outcome.kind === 'not_sent'}
								title="Open {lead.row.filePath} {range} in the diff{outcomeNote ? `. ${outcomeNote}` : ''}"
								onclick={() => onjump(lead.row.filePath, lead.row.newStart)}
							>
								<span
									class="lead-smells"
									title={lead.smells.map((s) => HUNK_SMELL_META[s.smell].label).join(', ')}
								>
									{#if top}
										{@const Icon = SMELL_ICONS[top.smell]}
										<span class="leads-tone--{smellTone(top.smell)}"><Icon size={12} weight="bold" /></span>
									{/if}
									{#if lead.smells.length > 1}
										<span class="lead-smells-more">+{lead.smells.length - 1}</span>
									{/if}
								</span>
								<span class="lead-path">
									<span class="lead-dir">{path.dir}</span>
									<span class="lead-name">{path.name}</span>
								</span>
								<span class="lead-range">{range}</span>
								<span class="lead-status">{status}</span>
								<span class="lead-pct">{top ? Math.round(top.probability * 100) : 0}%</span>
							</button>
							{#if reviewed && lead.outcome.kind === 'rejected' && lead.outcome.reason}
								<p class="lead-reason">{lead.outcome.reason}</p>
							{/if}
						</li>
					{/each}
				</ul>
				{#if filtered.length > PREVIEW}
					<button type="button" class="leads-more" onclick={() => (showAll = !showAll)}>
						{showAll ? 'Show fewer' : `Show all ${filtered.length}`}
					</button>
				{/if}
			{/if}
		</div>
	</FoldedDisclosure>
{/if}

<style>
	.leads-tone--warning {
		--tone: var(--color-warning);
	}

	.leads-tone--danger {
		--tone: var(--color-danger);
	}

	.leads-tally-item:focus-visible,
	.lead:focus-visible,
	.leads-more:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}

	.leads-toggle-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.leads-tally {
		display: flex;
		flex-shrink: 0;
		gap: 2px;
	}

	.leads-tally-item {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		height: 22px;
		padding: 0 6px;
		border: 1px solid transparent;
		border-radius: 999px;
		background: transparent;
		color: var(--color-text-muted);
		font: inherit;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}

	.leads-tally-item :global(svg) {
		color: var(--tone);
	}

	.leads-tally-item:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.leads-tally-item[aria-pressed="true"] {
		border-color: color-mix(in srgb, var(--tone) 40%, var(--color-border));
		background: color-mix(in srgb, var(--tone) 12%, transparent);
		color: var(--color-text-primary);
	}

	.leads-body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 6px 0 2px 8px;
	}

	.leads-note {
		margin: 0;
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.leads-note-label {
		margin-right: 4px;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.leads-list {
		/* Shared by the row's icon column and the reason's indent, so the
		   reason lines up under the path whatever its own font size. */
		--lead-icon-col: 32px;
		--lead-gap: 10px;
		--lead-pad: 4px;

		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.lead {
		display: grid;
		grid-template-columns: var(--lead-icon-col) minmax(0, 1fr) auto 5.5em 3em;
		column-gap: var(--lead-gap);
		align-items: center;
		width: 100%;
		height: 26px;
		padding: 0 8px 0 var(--lead-pad);
		border: none;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.lead:hover {
		background: var(--color-bg-tertiary);
	}

	.lead-smells {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.lead-smells-more {
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-muted);
	}

	.lead-smells > span {
		display: inline-flex;
		color: var(--tone);
	}

	/* Directory gives way before the file name does. */
	.lead-path {
		display: flex;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 11.5px;
		white-space: nowrap;
	}

	.lead-dir {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--color-text-muted);
	}

	.lead-name {
		flex-shrink: 0;
		color: var(--color-text-primary);
	}

	.lead-range {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.lead:hover .lead-range {
		color: var(--color-accent);
	}

	.lead-status {
		font-size: 10.5px;
		text-align: right;
		white-space: nowrap;
		color: var(--color-text-muted);
	}

	.lead--not-sent .lead-smells,
	.lead--not-sent .lead-path {
		opacity: 0.6;
	}

	/* Under the path column: the reason reads as the row's second line. */
	.lead-reason {
		display: -webkit-box;
		margin: -2px 0 4px;
		max-width: calc(var(--lead-pad) + var(--lead-icon-col) + var(--lead-gap) + 80ch);
		padding: 0 8px 0 calc(var(--lead-pad) + var(--lead-icon-col) + var(--lead-gap));
		overflow: hidden;
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--color-text-muted);
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}

	.lead-pct {
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		text-align: right;
		color: var(--color-text-muted);
	}

	.leads-more {
		align-self: flex-start;
		padding: 2px 4px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-muted);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}

	.leads-more:hover {
		color: var(--color-text-primary);
	}
</style>
