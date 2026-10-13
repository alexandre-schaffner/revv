<script lang="ts">
import type { CheckDetails, CiCheck, CiCheckBucket, CiRollup } from "@revv/shared";
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import LockSimple from "phosphor-svelte/lib/LockSimple";
import MinusCircle from "phosphor-svelte/lib/MinusCircle";
import { SvelteSet } from "svelte/reactivity";
import { Button } from "$lib/components/ui/button/index.js";
import { gsapSlide } from "$lib/motion";
import { RequestState } from "$lib/stores/_types";
import { openExternal } from "$lib/utils/open-external";
import CheckDetailsPanel from "./CheckDetailsPanel.svelte";
import CiGlyph, { bucketOfRollup } from "./CiGlyph.svelte";

interface Props {
  rollup: CiRollup | null;
  /** The token can't read checks (a GitHub App without `checks: read`). */
  denied: boolean;
  /** The PR on GitHub, where the checks can still be seen. */
  prUrl: string;
  details: ReadonlyMap<number, RequestState<CheckDetails>>;
  /** The viewer may re-run Actions jobs. */
  canRerun: boolean;
  onExpand: (checkRunId: number) => void;
  onRerunRuns: (runIds: number[]) => Promise<void>;
  onRerunJob: (jobId: number) => Promise<void>;
}

let { rollup, denied, prUrl, details, canRerun, onExpand, onRerunRuns, onRerunJob }: Props =
  $props();

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

const expanded = new SvelteSet<string>();
// The first failing check opens on its own: its log is why the reader came.
let autoExpanded: string | null = null;
$effect(() => {
  const first = checks.find((c) => c.bucket === "fail" && c.checkRunId !== null);
  if (!first || autoExpanded === first.key) return;
  autoExpanded = first.key;
  expanded.add(first.key);
  if (first.checkRunId !== null) onExpand(first.checkRunId);
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
const headBucket = $derived(
  failing > 0 ? "fail" : pending > 0 ? "pending" : bucketOfRollup(rollup?.state ?? null),
);

/** One sentence for where CI stands, the way GitHub's merge box says it. */
const headline = $derived.by(() => {
  if (denied) return "Checks unavailable";
  if (checks.length === 0) return "No checks";
  if (failing > 0) return `${failing} ${failing === 1 ? "check" : "checks"} failing`;
  if (pending > 0) return `${pending} ${pending === 1 ? "check" : "checks"} running`;
  return passing > 0 ? "All checks have passed" : "All checks were skipped";
});
const detail = $derived(
  denied
    ? "Revv's GitHub App needs Checks and Commit statuses read access to show CI here."
    : checks.length === 0
      ? "None reported for the head commit."
      : counts,
);

function toggle(check: CiCheck): void {
  if (expanded.has(check.key)) {
    expanded.delete(check.key);
  } else {
    expanded.add(check.key);
    if (check.checkRunId !== null) onExpand(check.checkRunId);
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
  await onRerunRuns(failedRunIds);
  rerunning = false;
}
</script>

{#snippet row(check: CiCheck)}
	{@const open = expanded.has(check.key)}
	{@const expandable = check.checkRunId !== null}
	{@const time = duration(check)}
	<li class="check" class:check--open={open}>
		<div class="check-row">
			{#if expandable}
				<button
					type="button"
					class="check-toggle"
					aria-expanded={open}
					aria-label="{open ? 'Hide' : 'Show'} details for {check.name}"
					onclick={() => toggle(check)}
				>
					<span class="check-caret" class:check-caret--open={open}><CaretRight size={10} weight="bold" /></span>
				</button>
			{:else}
				<span class="check-toggle"></span>
			{/if}
			<CiGlyph bucket={check.bucket} />
			<div class="check-name">
				<span class="check-title">
					{#if check.workflowName && check.workflowName !== check.name}<span class="check-workflow">{check.workflowName} /</span>{/if}
					{check.name}
				</span>
				{#if check.description || check.appName}
					<span class="check-desc">{check.description ?? check.appName}</span>
				{/if}
			</div>
			{#if check.required}<span class="check-required">Required</span>{/if}
			{#if time}<span class="check-time">{time}</span>{/if}
			<div class="check-actions">
				{#if canRerun && check.bucket === 'fail' && check.workflowRunId !== null && check.checkRunId !== null}
					{@const jobId = check.checkRunId}
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Re-run {check.name}"
						title="Re-run this job"
						onclick={() => void onRerunJob(jobId)}
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
						title="Open details"
						onclick={() => void openExternal(url)}
					>
						<ArrowSquareOut />
					</Button>
				{/if}
			</div>
		</div>
		{#if open && check.checkRunId !== null}
			{@const id = check.checkRunId}
			<div transition:gsapSlide>
				<CheckDetailsPanel
					request={details.get(id) ?? RequestState.idle()}
					onretry={() => onExpand(id)}
				/>
			</div>
		{/if}
	</li>
{/snippet}

<section class="checks" aria-label="Checks">
	<header class="checks-head">
		<span class="checks-mark" class:checks-mark--muted={!headBucket} aria-hidden="true">
			{#if headBucket}
				<CiGlyph bucket={headBucket} size={20} />
			{:else if denied}
				<LockSimple size={16} />
			{:else}
				<MinusCircle size={16} />
			{/if}
		</span>
		<div class="checks-text">
			<h2 class="checks-title">{headline}</h2>
			<p class="checks-detail">{detail}</p>
		</div>
		<div class="checks-actions">
			{#if canRerun && failedRunIds.length > 0}
				<Button variant="outline" size="sm" disabled={rerunning} onclick={() => void rerunAll()}>
					<ArrowClockwise />
					{rerunning ? 'Re-running…' : 'Re-run failed jobs'}
				</Button>
			{/if}
			{#if denied}
				<Button variant="outline" size="sm" onclick={() => void openExternal(`${prUrl}/checks`)}>
					<ArrowSquareOut />
					View on GitHub
				</Button>
			{/if}
		</div>
	</header>

	{#if checks.length > 0}
		<ul class="check-list">
			{#each needsAttention as check (check.key)}
				{@render row(check)}
			{/each}
			{#if settled.length > 0}
				{#if showSettled}
					{#each settled as check (check.key)}
						{@render row(check)}
					{/each}
				{/if}
				<li class="check-fold">
					<button type="button" aria-expanded={showSettled} onclick={() => (showSettled = !showSettled)}>
						<span class="check-caret" class:check-caret--open={showSettled}><CaretRight size={10} weight="bold" /></span>
						{showSettled ? 'Hide' : 'Show'}
						{needsAttention.length > 0 ? `${settled.length} successful or skipped` : `all ${settled.length}`}
						{settled.length === 1 ? 'check' : 'checks'}
					</button>
				</li>
			{/if}
		</ul>
	{/if}
</section>

<style>
	.checks {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-bg-primary);
	}

	.checks-head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 12px 12px 14px;
	}

	.checks-mark {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--color-bg-secondary);
	}

	.checks-mark--muted {
		color: var(--color-text-secondary);
	}

	.checks-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		min-width: 0;
	}

	.checks-title {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 600;
		line-height: 1.35;
		color: var(--color-text-primary);
	}

	.checks-detail {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.checks-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.check-list {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--color-border-subtle);
	}

	.check + .check,
	.check-fold {
		border-top: 1px solid var(--color-border-subtle);
	}

	.check-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 4px 8px 4px 6px;
	}

	.check-toggle {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 20px;
		height: 20px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: none;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	button.check-toggle:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.check-caret {
		display: inline-flex;
		transition: rotate var(--duration-snap) var(--ease-soft);
	}

	.check-caret--open {
		rotate: 90deg;
	}

	.check-name {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex: 1;
		min-width: 0;
	}

	.check-title {
		flex-shrink: 0;
		max-width: 60%;
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

	.check-fold button {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 36px;
		padding: 4px 12px;
		border: none;
		background: none;
		font: inherit;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		text-align: left;
		cursor: pointer;
	}

	.check-fold button:hover {
		color: var(--color-text-primary);
		background: var(--color-bg-secondary);
	}
</style>
