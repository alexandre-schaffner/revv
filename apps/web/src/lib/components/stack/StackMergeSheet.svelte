<script lang="ts">
import type { MergeMethod, StackMergePlan, StackMergePlanLayer, StackMergeRun } from "@revv/shared";
import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import CircleNotch from "phosphor-svelte/lib/CircleNotch";
import Clock from "phosphor-svelte/lib/Clock";
import Desktop from "phosphor-svelte/lib/Desktop";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import Warning from "phosphor-svelte/lib/Warning";
import { untrack } from "svelte";
import { expectedHeads } from "$lib/api/wire";
import { Shimmer } from "$lib/components/ai/shimmer";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import SegmentedControl, {
  type SegmentedOption,
} from "$lib/components/ui/segmented-control/SegmentedControl.svelte";
import { gsapFade, gsapFadeY, gsapPress, tokens } from "$lib/motion";
import { RequestState } from "$lib/stores/_types";
import {
  cancelStackMerge,
  closeStackMergeSheet,
  continueStackMerge,
  getMergeRun,
  getStackMergePlan,
  getStackMergeSheetPrId,
  loadStackMergePlan,
  type StackMergeAnswer,
  startStackMerge,
} from "$lib/stores/stack-merge.svelte";
import MergePickerRow from "./MergePickerRow.svelte";
import MergeProgressRow from "./MergeProgressRow.svelte";
import StackLayerList from "./StackLayerList.svelte";

// "Merge this stack through layer N." The layers read bottom-up toward the
// base branch, like the stack list; the list is also the picker for how far
// to go. Once confirmed, the same rows turn into the run's live progress,
// fed by `stack-merge:progress`. Mounted once in AppShell; opened by
// `openStackMergeSheet` from anywhere that offers the action.

const prId = $derived(getStackMergeSheetPrId());
const request = $derived(getStackMergePlan());
const plan = $derived<StackMergePlan | null>(request.status === "ok" ? request.data : null);

let through = $state<number | null>(null);
let method = $state<MergeMethod>("merge");
/** The last start, cancel or continue; its refusal shows until the next one. */
let action = $state<RequestState<StackMergeRun>>(RequestState.idle());
const submitting = $derived(action.status === "loading");
const actionError = $derived(action.status === "error" ? action.error : null);
/** A stopped run the user started over from: the picker shows in its place. */
let setAside = $state<string | null>(null);
/** When the sheet opened: a run that finished before it isn't news. */
let openedAt = 0;

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash",
  rebase: "Rebase",
};

/** The merge method that keeps the layers above clean: a merge commit, when allowed. */
function recommendedMethod(allowed: readonly MergeMethod[]): MergeMethod {
  if (allowed.length === 0 || allowed.includes("merge")) return "merge";
  return allowed[0] ?? "merge";
}

function applyDefaults(): void {
  const current = getStackMergePlan();
  if (current.status !== "ok") return;
  through = current.data.defaultThrough;
  method = recommendedMethod(current.data.allowedMethods);
}

$effect(() => {
  const id = prId;
  if (!id) return;
  untrack(() => {
    openedAt = Date.now();
    through = null;
    action = RequestState.idle();
    setAside = null;
    void loadStackMergePlan(id).then(applyDefaults);
  });
});

// ── The run ───────────────────────────────────────────────────────────────

const run = $derived.by<StackMergeRun | null>(() => {
  if (!plan) return null;
  const latest = getMergeRun(plan.repositoryId, plan.stackNumber);
  if (!latest || latest.id === setAside) return null;
  if (latest.status === "complete" || latest.status === "cancelled") {
    return Date.parse(latest.updatedAt) >= openedAt ? latest : null;
  }
  return latest;
});
const runLive = $derived(run?.status === "running" || run?.status === "waiting");
const runStopped = $derived(run?.status === "failed" || run?.status === "expired");

// A run that just ended moved the stack; re-read it so the rows say so.
let wasLive = false;
$effect(() => {
  const live = runLive;
  const id = prId;
  untrack(() => {
    const ended = wasLive && !live;
    wasLive = live;
    if (ended && id) void loadStackMergePlan(id, true);
  });
});

// ── The picker ────────────────────────────────────────────────────────────

const bottomUp = $derived(plan ? [...plan.layers].sort((a, b) => a.position - b.position) : []);
const topFirst = $derived([...bottomUp].reverse());

/**
 * Why a layer can't be the target: merged already, or something at or below
 * it is blocked. Null when it can.
 */
const pickRefusal = $derived.by(() => {
  const refusals = new Map<number, string>();
  let blocker: StackMergePlanLayer | null = null;
  for (const layer of bottomUp) {
    if (layer.readiness === "merged") {
      refusals.set(layer.position, "Already merged");
      continue;
    }
    if (blocker) {
      refusals.set(layer.position, `#${blocker.number} below can't merge yet`);
      continue;
    }
    if (layer.readiness === "blocked") {
      blocker = layer;
      refusals.set(layer.position, layer.reasons[0] ?? "Can't merge yet");
    }
  }
  return refusals;
});

const target = $derived(
  through !== null && !pickRefusal.has(through) ? through : (plan?.defaultThrough ?? null),
);
const toMerge = $derived(
  bottomUp.filter((l) => target !== null && l.position <= target && l.readiness !== "merged"),
);
const targetLayer = $derived(bottomUp.find((l) => l.position === target) ?? null);

const methodOptions = $derived.by<SegmentedOption<MergeMethod>[]>(() => {
  const allowed = plan?.allowedMethods ?? [];
  const all: MergeMethod[] = ["merge", "squash", "rebase"];
  return (allowed.length === 0 ? all : all.filter((m) => allowed.includes(m))).map((m) => ({
    value: m,
    label: METHOD_LABEL[m],
  }));
});
const mergeCommitAllowed = $derived(methodOptions.some((o) => o.value === "merge"));

const methodHint = $derived.by(() => {
  if (method === "merge") return "A merge commit keeps the layers above in step with what landed.";
  if (mergeCommitAllowed) {
    return `${METHOD_LABEL[method]} rewrites history the layers above still carry; they may need a rebase.`;
  }
  return "This repository doesn't allow merge commits, so the layers above may need a rebase.";
});

// ── Actions ───────────────────────────────────────────────────────────────

/** Run one call at a time; its answer becomes `action`. Null when one is already running. */
async function act(call: () => Promise<StackMergeAnswer>): Promise<StackMergeAnswer | null> {
  if (submitting) return null;
  action = RequestState.loading();
  const result = await call();
  action = result.ok ? RequestState.ok(result.run) : RequestState.error(result.error);
  return result;
}

async function confirm(): Promise<void> {
  const id = prId;
  const throughPosition = target;
  if (!id || !plan || throughPosition === null) return;
  const heads = expectedHeads(toMerge);
  const result = await act(() =>
    startStackMerge(id, { throughPosition, method, expectedHeads: heads }),
  );
  // The refusal usually means GitHub moved; show the stack as it is now.
  if (result && !result.ok) void loadStackMergePlan(id, true);
}

function cancelRun(): void {
  const runId = run?.id;
  if (runId) void act(() => cancelStackMerge(runId));
}

function continueRun(): void {
  const runId = run?.id;
  if (runId) void act(() => continueStackMerge(runId));
}

/** Leave the stopped run where it stopped and pick again from the stack as it is now. */
function startOver(): void {
  if (!run || !prId) return;
  setAside = run.id;
  through = null;
  action = RequestState.idle();
  void loadStackMergePlan(prId).then(applyDefaults);
}

function retry(): void {
  if (prId) void loadStackMergePlan(prId).then(applyDefaults);
}

function runState(number: number) {
  return run?.layers.find((l) => l.number === number) ?? null;
}

const title = $derived.by(() => {
  if (!plan) return "Merge stack";
  if (!run) return `Merge stack #${plan.stackNumber}`;
  switch (run.status) {
    case "complete":
      return "Stack merged";
    case "cancelled":
      return "Merge cancelled";
    case "failed":
    case "expired":
      return "Merge stopped";
    default:
      return `Merging stack #${plan.stackNumber}`;
  }
});

const runThrough = $derived(
  run ? (bottomUp.find((l) => l.position === run.throughPosition) ?? null) : null,
);

function onOpenChange(open: boolean): void {
  if (!open) closeStackMergeSheet();
}
</script>

{#snippet keepOpen()}
	<Desktop size={14} />
	<span>Keep Revv open until the stack is merged.</span>
{/snippet}

<Dialog.Root open={prId !== null} {onOpenChange}>
	<Dialog.Content class="stack-merge-sheet">
		<Dialog.Header>
			<Dialog.Title>
				<span class="title">
					<GitMerge size={18} weight="bold" />
					{title}
				</span>
			</Dialog.Title>
			<Dialog.Description>
				{#if plan}
					Merges bottom-up into <code>{plan.baseRefName}</code>, each layer pinned to the head
					you see here.
				{:else}
					Reading the stack from GitHub.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if request.status === 'loading' || request.status === 'idle'}
			<div class="placeholder" in:gsapFade={{ duration: tokens.quick }}>
				<CircleNotch size={16} class="motion-essential-spin" />
				<Shimmer>Reading the stack from GitHub…</Shimmer>
			</div>
		{:else if request.status === 'error'}
			<div class="placeholder placeholder--error" in:gsapFade={{ duration: tokens.quick }}>
				<Warning size={16} weight="fill" />
				<span>{request.error}</span>
				<Button variant="outline" size="sm" class="pill" onclick={retry}>Try again</Button>
			</div>
		{:else if plan}
			{#if run?.status === 'complete'}
				<div class="done" in:gsapFadeY={{ duration: tokens.smooth, y: 6 }}>
					<CheckCircle size={28} weight="fill" />
					<p>
						{#if runThrough}
							Merged through #{runThrough.number} into <code>{plan.baseRefName}</code>.
						{:else}
							Merged into <code>{plan.baseRefName}</code>.
						{/if}
					</p>
				</div>
			{/if}

			<StackLayerList
				layers={topFirst}
				baseRefName={plan.baseRefName}
				role={run ? 'list' : 'radiogroup'}
				aria-label={run ? 'Merge progress' : 'Merge through'}
				--stack-layer-gap="2px"
			>
				{#snippet row(layer)}
					{#if run}
						<MergeProgressRow
							{layer}
							progress={runState(layer.number)}
							live={runLive}
							waiting={run.status === 'waiting'}
							baseRefName={plan.baseRefName}
						/>
					{:else}
						<MergePickerRow
							{layer}
							refusal={pickRefusal.get(layer.position) ?? null}
							inRange={target !== null && layer.position <= target}
							isTarget={layer.position === target}
							onpick={() => (through = layer.position)}
						/>
					{/if}
				{/snippet}
			</StackLayerList>

			{#if !run}
				<div class="options">
					{#if methodOptions.length > 1}
						<SegmentedControl
							options={methodOptions}
							value={method}
							onValueChange={(next) => (method = next)}
							aria-label="Merge method"
						/>
					{/if}
					<p class="hint">{methodHint}</p>
					<p class="mode">
						{#if plan.mode === 'auto'}
							<Clock size={14} />
							<span>
								Layers still waiting on checks go to GitHub auto-merge, which finishes them even if
								you quit Revv.
							</span>
						{:else}
							{@render keepOpen()}
						{/if}
					</p>
				</div>
			{:else if run.error && run.status !== 'complete'}
				<p
					class="run-note"
					class:run-note--error={runStopped}
					in:gsapFadeY={{ duration: tokens.quick, y: 4 }}
				>
					{#if runStopped}<Warning size={14} weight="fill" />{/if}
					<span>{run.error}</span>
				</p>
			{:else if runLive && run.mode === 'driven'}
				<p class="run-note">
					{@render keepOpen()}
				</p>
			{/if}

			{#if actionError}
				<p class="run-note run-note--error" in:gsapFadeY={{ duration: tokens.quick, y: 4 }}>
					<Warning size={14} weight="fill" />
					<span>{actionError}</span>
				</p>
			{/if}

			<div class="actions">
				{#if !run}
					<Button variant="outline" size="sm" class="pill" onclick={closeStackMergeSheet}>
						Cancel
					</Button>
					<span use:gsapPress={{ disabled: target === null || submitting }}>
						<Button
							size="sm"
							class="pill pill--merge"
							disabled={target === null || submitting || toMerge.length === 0}
							onclick={confirm}
						>
							<GitMerge size={14} weight="bold" />
							{#if submitting}
								Starting…
							{:else if targetLayer && toMerge.length > 0}
								Merge {toMerge.length} {toMerge.length === 1 ? 'layer' : 'layers'} into {plan.baseRefName}
							{:else}
								Nothing can merge yet
							{/if}
						</Button>
					</span>
				{:else if runLive}
					<Button variant="outline" size="sm" class="pill" onclick={closeStackMergeSheet}>
						Close
					</Button>
					<Button variant="destructive" size="sm" class="pill" disabled={submitting} onclick={cancelRun}>
						Cancel merge
					</Button>
				{:else if runStopped}
					<Button variant="outline" size="sm" class="pill" onclick={closeStackMergeSheet}>
						Close
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="pill"
						disabled={submitting}
						title="Read the stack again and pick what to merge, at the heads it has now"
						onclick={startOver}
					>
						Start over
					</Button>
					<span use:gsapPress={{ disabled: submitting }}>
						<Button
							size="sm"
							class="pill pill--merge"
							disabled={submitting}
							title="Pick up where it stopped, with the heads you confirmed"
							onclick={continueRun}
						>
							<ArrowsClockwise size={14} weight="bold" />
							{submitting ? 'Continuing…' : 'Continue'}
						</Button>
					</span>
				{:else}
					<Button size="sm" class="pill" onclick={closeStackMergeSheet}>Done</Button>
				{/if}
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.stack-merge-sheet) {
		max-width: 520px !important;
		max-height: 72vh;
		overflow-y: auto;
		overflow-x: hidden;
	}

	:global(.stack-merge-sheet .pill) {
		border-radius: 999px;
	}

	:global(.stack-merge-sheet .pill--merge) {
		background: var(--color-success);
		color: var(--color-bg-primary);
	}

	.title {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	code {
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.placeholder {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 16px 4px;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.placeholder--error {
		flex-wrap: wrap;
		color: var(--color-danger);
	}

	.placeholder--error span {
		flex: 1;
		min-width: 0;
	}

	.done {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		border-radius: 10px;
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 10%, transparent);
	}

	.done p {
		margin: 0;
		font-size: 0.875rem;
		color: var(--color-text-primary);
	}

	/* The two kinds of row, the picker's and the run's, share one frame and type. */
	:global(.stack-merge-sheet .layer-row) {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border: 1px solid transparent;
		border-radius: 8px;
	}

	:global(.stack-merge-sheet .layer-text) {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		min-width: 0;
	}

	:global(.stack-merge-sheet .layer-title) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1.35;
		color: var(--color-text-primary);
	}

	:global(.stack-merge-sheet .layer-meta) {
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.options {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
	}

	.hint,
	.mode,
	.run-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.mode :global(svg),
	.run-note :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.run-note--error {
		padding: 8px 10px;
		border-radius: 8px;
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 8%, transparent);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	:global(.stack-merge-sheet .tone-merged) {
		color: var(--color-merged);
	}

	:global(.stack-merge-sheet .tone-danger) {
		color: var(--color-danger);
	}

	:global(.stack-merge-sheet .tone-warning) {
		color: var(--color-warning);
	}

	:global(.stack-merge-sheet .tone-accent) {
		color: var(--color-accent);
	}

	:global(.stack-merge-sheet .tone-muted) {
		color: var(--color-text-muted);
	}
</style>
