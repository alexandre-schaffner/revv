<script lang="ts">
import { HUNK_SMELL_META, type HunkSmell } from "@revv/shared";
import Check from "phosphor-svelte/lib/Check";
import Minus from "phosphor-svelte/lib/Minus";
import { type LeadOutcome, leadOutcomeNote, smellTone } from "$lib/utils/hunk-scan";
import { SMELL_ICONS } from "./smell-icons";

/**
 * One first-pass smell on one hunk: icon, label, probability. `outcome` says
 * what the review made of the lead — a check once it became an issue, a dash
 * when the review checked it and set it aside, muted and dashed when it
 * finished without either, faded when the lead was never handed to it.
 */
interface Props {
  smell: HunkSmell;
  probability: number;
  outcome?: LeadOutcome | undefined;
}

let { smell, probability, outcome }: Props = $props();

const Icon = $derived(SMELL_ICONS[smell]);
const meta = $derived(HUNK_SMELL_META[smell]);
const percent = $derived(Math.round(probability * 100));
const note = $derived(outcome ? leadOutcomeNote(outcome) : null);
const title = $derived(note ? `${meta.description} ${note}` : meta.description);
const classes = $derived([
  "smell-chip",
  `smell-chip--${smellTone(smell)}`,
  outcome && `smell-chip--${outcome.kind}`,
]);
</script>

<span class={classes} {title}>
	<Icon size={11} />
	<span>{meta.label}</span>
	<span class="smell-chip-pct">{percent}%</span>
	{#if outcome?.kind === 'confirmed'}
		<Check size={10} />
	{:else if outcome?.kind === 'rejected'}
		<Minus size={10} />
	{/if}
</span>

<style>
	.smell-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 20px;
		padding: 0 7px;
		border: 1px solid color-mix(in srgb, var(--smell-tone) 28%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--smell-tone) 10%, transparent);
		color: var(--smell-tone);
		font-size: 10.5px;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
	}

	.smell-chip--warning {
		--smell-tone: var(--color-warning);
	}

	.smell-chip--danger {
		--smell-tone: var(--color-danger);
	}

	.smell-chip--not_raised,
	.smell-chip--unchecked,
	.smell-chip--rejected,
	.smell-chip--withdrawn,
	.smell-chip--not_sent {
		border-style: dashed;
		border-color: var(--color-border);
		background: transparent;
		color: var(--color-text-muted);
	}

	/* Never in front of the review, so it says less than one it passed over. */
	.smell-chip--not_sent {
		border-style: dotted;
		opacity: 0.6;
	}

	.smell-chip-pct {
		font-variant-numeric: tabular-nums;
		opacity: 0.7;
	}
</style>
