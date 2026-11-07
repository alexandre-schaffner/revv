<script lang="ts">
import type { BaseConflictStrategy, PrConversation } from "@revv/shared";
import { hasMergeConflicts } from "@revv/shared";
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import FileText from "phosphor-svelte/lib/FileText";
import Sparkle from "phosphor-svelte/lib/Sparkle";
import Spinner from "phosphor-svelte/lib/Spinner";
import Warning from "phosphor-svelte/lib/Warning";
import XCircle from "phosphor-svelte/lib/XCircle";
import { untrack } from "svelte";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import DisclosureCaret from "$lib/components/shared/DisclosureCaret.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { gsapSlide } from "$lib/motion";
import {
  checkBaseConflicts,
  dismissBaseConflictRun,
  getBaseConflicts,
  resolveBaseConflicts,
} from "$lib/stores/base-conflicts.svelte";
import { useMergeEligibility } from "$lib/stores/merge-eligibility.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { openSettings } from "$lib/stores/settingsModal.svelte";
import { plural } from "$lib/utils/plural";
import MergeBoxCard from "./MergeBoxCard.svelte";

// "This branch has conflicts with main", where GitHub's merge box would say
// it, plus the files and a way to hand the fix to the agent. GitHub's
// mergeability says whether; Revv's own `git merge-tree` says which files.

interface Props {
  prId: string;
  conversation: PrConversation;
}

let { prId, conversation }: Props = $props();

const FILES_SHOWN = 5;

const pr = $derived(getPrById(prId));
const headSha = $derived(pr?.headSha ?? null);
const baseBranch = $derived(pr?.targetBranch ?? "the base branch");
const sourceBranch = $derived(pr?.sourceBranch ?? "this branch");
// A stacked layer conflicts with the layer below; "Rebase stack" in the
// sidebar is the fix for that, and a merge commit would bend the stack.
const applies = $derived(pr?.status === "open" && pr.stack === null);
const strategy = $derived<BaseConflictStrategy>(getSettings().baseConflictStrategy);

const eligibility = useMergeEligibility(
  () => prId,
  () => applies,
);
const githubDirty = $derived(applies && hasMergeConflicts(eligibility.current?.mergeStateStatus));

const view = $derived(getBaseConflicts(prId, headSha));
const local = $derived(view.check);
const checking = $derived(view.checking);
const checkError = $derived(view.error);
const run = $derived(view.run);
const running = $derived(run?.outcome.status === "loading" || local?.resolving === true);

$effect(() => {
  if (!applies || !githubDirty) return;
  const sha = headSha;
  untrack(() => checkBaseConflicts(prId, sha));
});

const files = $derived(local?.status === "conflicts" ? local.files : []);
const visible = $derived(
  applies && (githubDirty || local?.status === "conflicts" || running || run !== null),
);

let showAllFiles = $state(false);
let showLog = $state<boolean | null>(null);
let confirming = $state(false);

const shownFiles = $derived(showAllFiles ? files : files.slice(0, FILES_SHOWN));
const logOpen = $derived(showLog ?? run?.outcome.status === "error");

const headline = $derived(
  running
    ? `Resolving conflicts with ${baseBranch}`
    : run?.outcome.status === "ok"
      ? `Up to date with ${baseBranch}`
      : `This branch has conflicts with ${baseBranch}`,
);

const detail = $derived.by(() => {
  if (run?.outcome.status === "ok") return `Pushed to ${run.outcome.data.branch}.`;
  if (local?.status === "conflicts") {
    const behind = local.behindBy ? ` · ${plural(local.behindBy, "commit")} behind` : "";
    return `${plural(files.length, "conflicting file")}${behind}`;
  }
  if (checking && !local) return "Checking which files conflict…";
  if (local?.status === "unavailable")
    return `Revv couldn't list the files: ${local.reason ?? "unknown reason"}`;
  if (checkError) return `Revv couldn't list the files: ${checkError}`;
  if (local?.status === "clean") {
    return `${baseBranch}'s latest tip merges cleanly here; GitHub may still be catching up.`;
  }
  return "Resolve them before this can be merged.";
});

const blockedReason = $derived.by(() => {
  if (!conversation.viewerCanPush) return `You can't push to ${sourceBranch}`;
  const unpushed = local?.unpushedAgentCommits ?? 0;
  if (strategy === "rebase" && unpushed > 0) {
    return `Push or discard the agent's ${plural(unpushed, "unpushed commit")} in the chat panel first — a rebase would strand them.`;
  }
  return null;
});

const strategyCaption = $derived(
  strategy === "merge"
    ? `The agent merges ${baseBranch} into ${sourceBranch} and pushes.`
    : `The agent rebases ${sourceBranch} onto ${baseBranch} and force-pushes (with lease).`,
);

function start(): void {
  const expected = local?.headSha ?? headSha;
  if (!expected) return;
  confirming = false;
  showLog = null;
  resolveBaseConflicts(prId, expected);
}

function onResolveClick(): void {
  if (strategy === "rebase") confirming = true;
  else start();
}
</script>

{#if visible}
	<MergeBoxCard
		label="Conflicts with {baseBranch}"
		title={headline}
		{detail}
		markTone={run?.outcome.status === 'ok' ? 'success' : 'warning'}
	>
		{#snippet mark()}
			{#if running}
				<Spinner size={16} class="motion-essential-spin" />
			{:else if run?.outcome.status === 'ok'}
				<CheckCircle size={18} weight="fill" />
			{:else}
				<Warning size={18} weight="fill" />
			{/if}
		{/snippet}
		{#snippet actions()}
			{#if local?.status === 'clean' && !running}
				<Button
					variant="ghost"
					size="sm"
					disabled={checking}
					onclick={() => checkBaseConflicts(prId, headSha, { force: true })}
				>
					<ArrowClockwise />Recheck
				</Button>
			{/if}
			{#if !running && run?.outcome.status !== 'ok' && !confirming}
				<Button
					variant="outline"
					size="sm"
					disabled={blockedReason !== null}
					title={blockedReason ?? strategyCaption}
					onclick={onResolveClick}
				>
					<Sparkle />Resolve with agent
				</Button>
			{/if}
		{/snippet}

		{#if files.length > 0}
			<ul class="conflict-files">
				{#each shownFiles as file (file)}
					<li class="conflict-file">
						<FileText size={14} aria-hidden="true" />
						<span class="conflict-path" title={file}>{file}</span>
					</li>
				{/each}
				{#if files.length > FILES_SHOWN}
					<li>
						<button
							type="button"
							class="conflicts-fold"
							aria-expanded={showAllFiles}
							onclick={() => (showAllFiles = !showAllFiles)}
						>
							{showAllFiles ? 'Show fewer' : `Show ${files.length - FILES_SHOWN} more`}
						</button>
					</li>
				{/if}
			</ul>
		{/if}

		{#if local?.touchesWorkflows && !running && run?.outcome.status !== 'ok'}
			<p class="conflicts-note">
				<Warning size={13} aria-hidden="true" />
				<span>
					{baseBranch} changed files under <code>.github/workflows/</code>. GitHub won't let Revv's
				credential push those, so this push will likely be refused — update the branch from your own
				checkout instead.
				</span>
			</p>
		{/if}

		{#if confirming}
			<div class="conflicts-confirm" transition:gsapSlide>
				<p>
					Rebasing rewrites <code>{sourceBranch}</code>'s history and force-pushes it. Anyone with
					it checked out will need to reset onto the new head.
				</p>
				<div class="conflicts-confirm-actions">
					<Button variant="ghost" size="sm" onclick={() => (confirming = false)}>Cancel</Button>
					<Button variant="default" size="sm" onclick={start}>
						<Sparkle />Rebase and force-push
					</Button>
				</div>
			</div>
		{/if}

		{#if run}
			<div class="conflicts-run">
				{#if run.status}
					<p class="run-status">{run.status}</p>
				{/if}
				{#if run.outcome.status === 'error'}
					<p class="run-error" role="alert">
						<XCircle size={14} aria-hidden="true" />
						<span>{run.outcome.error}</span>
						<Button variant="ghost" size="xs" onclick={() => dismissBaseConflictRun(prId)}>
							Dismiss
						</Button>
					</p>
				{/if}
				{#if run.rows.length > 0 || run.agentText.length > 0}
					<button
						type="button"
						class="conflicts-fold"
						aria-expanded={logOpen}
						aria-controls="base-conflicts-log"
						onclick={() => (showLog = !logOpen)}
					>
						<span class="fold-caret" aria-hidden="true"><DisclosureCaret open={logOpen} /></span>
						{logOpen ? 'Hide' : 'Show'} what the agent did
						{#if run.rows.length > 0}({plural(run.rows.length, 'step')}){/if}
					</button>
					{#if logOpen}
						<div id="base-conflicts-log" class="run-log" transition:gsapSlide>
							{#if run.rows.length > 0}
								<ol class="run-steps">
									{#each run.rows as row (row.id)}
										<li>
											{#if row.toolName}<span class="run-tool">{row.toolName}</span>{/if}
											{row.summary}
										</li>
									{/each}
								</ol>
							{/if}
							{#if run.agentText.length > 0}
								<Markdown source={run.agentText} trust="external" density="dense" class="wrap-anywhere" />
							{/if}
						</div>
					{/if}
				{/if}
			</div>
		{/if}

		{#if !running && run?.outcome.status !== 'ok'}
			<footer class="conflicts-foot">
				{#if blockedReason}
					<span>{blockedReason}</span>
				{:else}
					<span>{strategyCaption}</span>
					<button type="button" class="conflicts-link" onclick={() => openSettings('ai')}>
						Change
					</button>
				{/if}
			</footer>
		{/if}
	</MergeBoxCard>
{/if}

<style>
	.conflict-files {
		margin: 0;
		padding: 4px 0;
		list-style: none;
		border-top: 1px solid var(--color-border-subtle);
	}

	.conflict-file {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 28px;
		padding: 0 14px 0 22px;
		color: var(--color-text-muted);
	}

	.conflict-path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-primary);
	}

	.conflicts-fold {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		padding: 0 14px 0 22px;
		border: none;
		background: none;
		font: inherit;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.conflicts-fold:hover {
		color: var(--color-text-primary);
	}

	.conflicts-fold:focus-visible,
	.conflicts-link:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.fold-caret {
		display: grid;
		place-items: center;
		width: 12px;
	}

	.conflicts-note {
		display: flex;
		align-items: baseline;
		gap: 6px;
		margin: 0;
		padding: 10px 14px;
		border-top: 1px solid var(--color-border-subtle);
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.conflicts-note :global(svg) {
		flex-shrink: 0;
		color: var(--color-warning);
		translate: 0 2px;
	}

	.conflicts-confirm {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		border-top: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.conflicts-confirm p {
		margin: 0;
	}

	.conflicts-confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
	}

	.conflicts-run {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 0;
		border-top: 1px solid var(--color-border-subtle);
	}

	.run-status {
		margin: 0;
		padding: 0 14px 0 22px;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.run-error {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		padding: 0 8px 0 22px;
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.run-error span {
		flex: 1;
		min-width: 0;
		color: var(--color-danger);
	}

	.run-error > :global(svg) {
		flex-shrink: 0;
		color: var(--color-danger);
	}

	.run-log {
		display: flex;
		flex-direction: column;
		gap: 8px;
		overflow: hidden;
		padding: 0 14px 4px 22px;
	}

	.run-steps {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.run-tool {
		margin-right: 6px;
		font-family: var(--font-mono);
		color: var(--color-text-muted);
	}

	.conflicts-foot {
		display: flex;
		align-items: baseline;
		gap: 6px;
		padding: 8px 14px;
		border-top: 1px solid var(--color-border-subtle);
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.conflicts-link {
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		color: var(--color-text-secondary);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.conflicts-link:hover {
		color: var(--color-text-primary);
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.75rem;
	}
</style>
