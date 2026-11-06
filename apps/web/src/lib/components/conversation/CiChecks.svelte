<script lang="ts">
import { type CiCheck, type CiCheckBucket, ciStanding, type PrConversation } from "@revv/shared";
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import LockSimple from "phosphor-svelte/lib/LockSimple";
import MinusCircle from "phosphor-svelte/lib/MinusCircle";
import { SvelteSet } from "svelte/reactivity";
import DisclosureCaret from "$lib/components/shared/DisclosureCaret.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { gsapSlide } from "$lib/motion";
import { RequestState } from "$lib/stores/_types";
import {
  getAbilities,
  getConversation,
  loadCheckDetails,
  rerunFailedRuns,
  rerunJob,
} from "$lib/stores/conversation.svelte";
import { openExternal } from "$lib/utils/open-external";
import CheckDetailsPanel from "./CheckDetailsPanel.svelte";
import CiGlyph from "./CiGlyph.svelte";
import MergeBoxCard from "./MergeBoxCard.svelte";

interface Props {
  prId: string;
  conversation: PrConversation;
}

let { prId, conversation }: Props = $props();

const rollup = $derived(conversation.ci);
/** The token can't read checks (a GitHub App without `checks: read`). */
const denied = $derived(conversation.ciAccess === "denied");
const details = $derived(getConversation(prId).checkDetails);
const canRerun = $derived(getAbilities(prId).canRerun);

function expand(checkRunId: number): void {
  void loadCheckDetails(prId, checkRunId);
}

const ORDER: Record<CiCheckBucket, number> = { fail: 0, pending: 1, pass: 2, skip: 3 };

const checks = $derived(
  [...(rollup?.checks ?? [])].sort(
    (a, b) => ORDER[a.bucket] - ORDER[b.bucket] || a.name.localeCompare(b.name),
  ),
);
const count = (bucket: CiCheckBucket) => checks.filter((c) => c.bucket === bucket).length;
const failing = $derived(count("fail"));
const pending = $derived(count("pending"));
const passing = $derived(count("pass"));
const skipped = $derived(count("skip"));

/** Passing and skipped checks fold away: the rows worth reading are the rest. */
const settled = $derived(checks.filter((c) => c.bucket === "pass" || c.bucket === "skip"));
const needsAttention = $derived(
  checks.filter((c) => c.bucket === "fail" || c.bucket === "pending"),
);
let showSettled = $state(false);

const failedRunIds = $derived([
  ...new Set(
    checks
      .filter((c) => c.bucket === "fail" && c.workflowRunId !== null)
      .map((c) => c.workflowRunId as number),
  ),
]);
let rerunning = $state(false);

function canRerunJob(check: CiCheck): boolean {
  return (
    canRerun && check.bucket === "fail" && check.workflowRunId !== null && check.checkRunId !== null
  );
}
/** Any row carries a re-run icon: every row reserves its slot so times line up. */
const rerunColumn = $derived(checks.some(canRerunJob));

const expanded = new SvelteSet<string>();
// The first failing check opens on its own: its log is why the reader came.
let autoExpanded: string | null = null;
$effect(() => {
  const first = checks.find((c) => c.bucket === "fail" && c.checkRunId !== null);
  if (!first || autoExpanded === first.key) return;
  autoExpanded = first.key;
  expanded.add(first.key);
  if (first.checkRunId !== null) expand(first.checkRunId);
});

const counts = $derived(
  [
    failing > 0 ? `${failing} failing` : null,
    pending > 0 ? `${pending} pending` : null,
    passing > 0 ? `${passing} passed` : null,
    skipped > 0 ? `${skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(" · "),
);
const headBucket = $derived(ciStanding(rollup));

/**
 * One sentence for where CI stands, the way GitHub's merge box says it. The
 * numbers live in the line under it, so the headline doesn't repeat them.
 */
const headline = $derived.by(() => {
  if (denied) return "Checks unavailable";
  if (headBucket === "fail") return "Some checks were not successful";
  if (headBucket === "pending") return "Some checks haven't completed yet";
  if (checks.length === 0) return "No checks";
  return passing > 0 ? "All checks have passed" : "All checks were skipped";
});
const detail = $derived(
  denied
    ? "Revv's GitHub App needs Checks and Commit statuses read access to show CI here."
    : checks.length === 0
      ? "None reported for the head commit."
      : counts,
);

/**
 * Same words as the count line, so the fold names what it hides the same way.
 * When it hides every check, the count line already says that much.
 */
const settledLabel = $derived(
  needsAttention.length === 0
    ? `all ${settled.length} ${settled.length === 1 ? "check" : "checks"}`
    : [passing > 0 ? `${passing} passed` : null, skipped > 0 ? `${skipped} skipped` : null]
        .filter(Boolean)
        .join(", "),
);

/** Actions jobs already name themselves by workflow; the app is noise there. */
function subtitle(check: CiCheck): string | null {
  return check.description ?? (check.workflowName ? null : check.appName);
}

function toggle(check: CiCheck): void {
  if (expanded.has(check.key)) {
    expanded.delete(check.key);
  } else {
    expanded.add(check.key);
    if (check.checkRunId !== null) expand(check.checkRunId);
  }
}

function duration(check: CiCheck): string | null {
  // A skipped job never ran; "0s" would read as a real (instant) run.
  if (!check.startedAt || check.bucket === "skip") return null;
  const end = check.completedAt ? Date.parse(check.completedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(check.startedAt)) / 1000));
  if (Number.isNaN(seconds)) return null;
  const text = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return check.completedAt ? text : `running ${text}`;
}

async function rerunAll(): Promise<void> {
  rerunning = true;
  try {
    await rerunFailedRuns(prId, failedRunIds);
  } finally {
    rerunning = false;
  }
}
</script>

{#snippet summary(check: CiCheck, open: boolean)}
	{@const time = duration(check)}
	{@const sub = subtitle(check)}
	<span class="check-caret" aria-hidden="true">
		{#if check.checkRunId !== null}<DisclosureCaret {open} />{/if}
	</span>
	<CiGlyph bucket={check.bucket} />
	<span class="check-name">
		<span class="check-title" title={check.workflowName && check.workflowName !== check.name ? `${check.workflowName} / ${check.name}` : check.name}>
			{#if check.workflowName && check.workflowName !== check.name}<span class="check-workflow">{check.workflowName} /</span>{/if}
			{check.name}
		</span>
		{#if sub}<span class="check-desc">{sub}</span>{/if}
	</span>
	{#if check.required}<span class="check-required">Required</span>{/if}
	{#if time}<span class="check-time">{time}</span>{/if}
{/snippet}

{#snippet row(check: CiCheck)}
	{@const open = expanded.has(check.key)}
	{@const detailsId = `check-details-${check.key}`}
	<li class="check">
		<div class="check-row">
			<!-- The whole row is the disclosure, not just the caret: the name is
			     what a reader aims at. The action icons sit outside it. -->
			{#if check.checkRunId !== null}
				<button
					type="button"
					class="check-summary"
					aria-expanded={open}
					aria-controls={detailsId}
					onclick={() => toggle(check)}
				>
					{@render summary(check, open)}
				</button>
			{:else}
				<div class="check-summary">{@render summary(check, false)}</div>
			{/if}
			<div class="check-actions">
				{#if canRerunJob(check) && check.checkRunId !== null}
					{@const jobId = check.checkRunId}
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Re-run {check.name}"
						title="Re-run this job"
						onclick={() => void rerunJob(prId, jobId)}
					>
						<ArrowClockwise />
					</Button>
				{/if}
				{#if check.url}
					{@const url = check.url}
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Open {check.name} on GitHub"
						title="Open on GitHub"
						onclick={() => void openExternal(url)}
					>
						<ArrowSquareOut />
					</Button>
				{/if}
			</div>
		</div>
		{#if open && check.checkRunId !== null}
			{@const id = check.checkRunId}
			<div id={detailsId} transition:gsapSlide>
				<CheckDetailsPanel
					request={details.get(id) ?? RequestState.idle()}
					onretry={() => expand(id)}
				/>
			</div>
		{/if}
	</li>
{/snippet}

<MergeBoxCard
	label="Checks"
	title={headline}
	{detail}
	markTone={headBucket ? null : 'muted'}
>
	{#snippet mark()}
		{#if headBucket}
			<CiGlyph bucket={headBucket} size={20} />
		{:else if denied}
			<LockSimple size={16} />
		{:else}
			<MinusCircle size={16} />
		{/if}
	{/snippet}
	{#snippet actions()}
		{#if canRerun && failedRunIds.length > 0}
			<Button variant="outline" size="sm" disabled={rerunning} onclick={() => void rerunAll()}>
				<ArrowClockwise />
				{rerunning ? 'Re-running…' : 'Re-run failed jobs'}
			</Button>
		{/if}
		{#if denied}
			<Button
				variant="outline"
				size="sm"
				onclick={() => void openExternal(`${conversation.url}/checks`)}
			>
				<ArrowSquareOut />
				View on GitHub
			</Button>
		{/if}
	{/snippet}

	{#if checks.length > 0}
		<ul class="check-list" class:check-list--rerun={rerunColumn}>
			{#each needsAttention as check (check.key)}
				{@render row(check)}
			{/each}
			{#if settled.length > 0}
				<!-- The fold sits above what it reveals, so it stays under the
				     pointer instead of jumping to the bottom of the list. -->
				<li class="check-fold">
					<button
						type="button"
						class="check-summary"
						aria-expanded={showSettled}
						aria-controls="checks-settled"
						onclick={() => (showSettled = !showSettled)}
					>
						<span class="check-caret" aria-hidden="true"><DisclosureCaret open={showSettled} /></span>
						{showSettled ? 'Hide' : 'Show'} {settledLabel}
					</button>
				</li>
				{#if showSettled}
					<li class="check-settled" transition:gsapSlide>
						<ul id="checks-settled">
							{#each settled as check (check.key)}
								{@render row(check)}
							{/each}
						</ul>
					</li>
				{/if}
			{/if}
		</ul>
	{/if}
</MergeBoxCard>

<style>
	.check-list,
	.check-settled > ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.check-list {
		border-top: 1px solid var(--color-border-subtle);
	}

	.check-list li + li {
		border-top: 1px solid var(--color-border-subtle);
	}

	.check-settled {
		overflow: hidden;
	}

	.check-row {
		display: flex;
		align-items: center;
		padding-right: 8px;
	}

	.check-row:has(> button.check-summary:hover),
	.check-fold:hover {
		background: var(--color-tree-hover-bg);
	}

	/* The disclosure: caret, glyph, name, and meta. Its 6px inset and 20px
	   caret slot put the glyph on the same column in every row, the fold
	   included, and CheckDetailsPanel indents its body to that column. */
	.check-summary {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		min-height: 40px;
		padding: 4px 8px 4px 6px;
		border: none;
		border-radius: inherit;
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
	}

	button.check-summary {
		cursor: pointer;
	}

	button.check-summary:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}

	.check-caret {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 20px;
		height: 20px;
		color: var(--color-text-muted);
	}

	button.check-summary:hover .check-caret {
		color: var(--color-text-primary);
	}

	.check-name {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex: 1;
		min-width: 0;
	}

	/* The subtitle gives way long before the name does. */
	.check-title {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.check-workflow {
		font-weight: 400;
		color: var(--color-text-secondary);
	}

	.check-desc {
		flex: 0 100 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.check-required {
		flex-shrink: 0;
		padding: 0 6px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font-size: 0.6875rem;
		line-height: 16px;
		color: var(--color-text-secondary);
	}

	.check-time {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.check-actions {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}

	/* Two icon-xs buttons and their gap. */
	.check-list--rerun .check-actions {
		justify-content: flex-end;
		min-width: 50px;
	}

	.check-fold .check-summary {
		min-height: 36px;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.check-fold .check-summary:hover {
		color: var(--color-text-primary);
	}
</style>
