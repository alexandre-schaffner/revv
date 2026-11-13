<script lang="ts">
import type { PullRequest, WalkthroughReviewRound } from "@revv/shared";
import { DropdownMenu } from "bits-ui";
import CaretUp from "phosphor-svelte/lib/CaretUp";
import Check from "phosphor-svelte/lib/Check";
import ClockCounterClockwise from "phosphor-svelte/lib/ClockCounterClockwise";
import Notebook from "phosphor-svelte/lib/Notebook";
import Spinner from "phosphor-svelte/lib/Spinner";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import { untrack } from "svelte";
import { getPrCommits, loadPrCommits } from "$lib/review/pr-commits.svelte";
import { setActiveTab } from "$lib/stores/pr-view-state.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { WALKTHROUGH_PERSPECTIVES } from "$lib/walkthrough/perspective";
import {
  getDisplayedWalkthroughId,
  getReviewRounds,
  loadReviewRounds,
  selectWalkthroughReport,
} from "$lib/walkthrough/store.svelte";

let { pr }: { pr: PullRequest } = $props();

let open = $state(false);
// The head the list was last asked at. The live head can move while the menu
// is open (the list itself can reveal that); the next open asks again.
let askedHead = $state<string | null>(null);
const listing = $derived(getPrCommits(pr.id, askedHead));
const commits = $derived(listing.request.status === "ok" ? listing.request.data : null);

// The commit list doubles as the walkthrough history: a commit a walkthrough
// reviewed up to (`round.toSha`) loads that report into the walkthrough tab.
// `pr` is the route's, so this only ever renders on its review page.
const displayedWalkthroughId = $derived(getDisplayedWalkthroughId(pr.id));

// Newest first, so a commit's first report is the one its row opens. A run
// stopped or superseded before its overview has nothing to show, so it's left
// out rather than opening onto an empty page.
const reportRounds = $derived.by((): WalkthroughReviewRound[] => {
  const rounds = getReviewRounds(pr.id)?.rounds ?? [];
  return rounds
    .filter((round) => round.visibility !== "hidden")
    .filter((round) => round.status === "generating" || Boolean(round.summary))
    .sort((a, b) => b.roundNumber - a.roundNumber);
});

// History spans both perspectives; name each run's only when it has both.
const mixedPerspectives = $derived(new Set(reportRounds.map((round) => round.mode)).size > 1);

const reportsBySha = $derived(Map.groupBy(reportRounds, (round) => round.toSha));

// Reports whose commit is gone from the branch (force-push / rebase).
const orphanedReports = $derived.by((): WalkthroughReviewRound[] => {
  if (commits === null) return [];
  const listed = new Set(commits.map((commit) => commit.sha));
  return reportRounds.filter((round) => !listed.has(round.toSha));
});

const displayedRound = $derived(
  reportRounds.find((round) => round.walkthroughId === displayedWalkthroughId) ?? null,
);
// Looking back in time: the walkthrough on screen isn't the newest one.
const viewingPastReport = $derived(
  displayedRound !== null && displayedRound.id !== reportRounds[0]?.id,
);

let choosing = $state(false);

async function chooseReport(round: WalkthroughReviewRound): Promise<void> {
  if (choosing) return;
  choosing = true;
  setActiveTab("walkthrough");
  try {
    // A generating round is the live one: follow it through `current` so the
    // stream keeps applying, rather than pinning a half-written snapshot.
    const reportId = round.status === "generating" ? null : round.walkthroughId;
    await selectWalkthroughReport(pr.id, reportId);
  } finally {
    choosing = false;
  }
}

function reportLabel(round: WalkthroughReviewRound): string {
  const scope = round.kind === "incremental" ? "New commits" : "Full PR";
  const kind = mixedPerspectives
    ? `${scope} · ${WALKTHROUGH_PERSPECTIVES[round.mode].label}`
    : scope;
  if (round.status === "generating") return `${kind} · generating`;
  if (round.status === "error") return `${kind} · stopped`;
  return `${kind} · ${formatRelativeTime(round.completedAt ?? round.createdAt)}`;
}

$effect(() => {
  // Only `open` is tracked: SSE-driven PR updates mustn't re-ask while it's open.
  if (!open) return;
  const { id: prId, headSha } = untrack(() => ({ id: pr.id, headSha: pr.headSha }));
  askedHead = headSha;
  loadPrCommits(prId, headSha);
  // A round can finish while the menu is shut.
  void loadReviewRounds(prId);
});
</script>

{#snippet reportRow(round: WalkthroughReviewRound, sha: string | null)}
	{@const active = round.walkthroughId === displayedWalkthroughId}
	<DropdownMenu.Item
		disabled={choosing}
		onSelect={() => chooseReport(round)}
		class="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs outline-none data-[highlighted]:bg-bg-elevated {active ? 'text-text-primary' : 'text-text-muted'}"
	>
		<div class="h-4 w-4 shrink-0"></div>
		{#if sha !== null}
			<span class="shrink-0 font-mono text-xs text-text-muted">{sha.slice(0, 7)}</span>
			<span class="flex-1 truncate">{reportLabel(round)}</span>
		{:else}
			<span class="flex-1 truncate">Earlier run · {reportLabel(round)}</span>
		{/if}
		<span class="flex w-3 shrink-0 justify-end">
			{#if active}<Check size={12} />{/if}
		</span>
	</DropdownMenu.Item>
{/snippet}

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger>
		<button
			class="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-mono text-xs text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-secondary"
			title={viewingPastReport ? "Viewing an earlier walkthrough" : undefined}
		>
			{#if viewingPastReport && displayedRound}
				<ClockCounterClockwise size={11} class="shrink-0 text-accent" />
				<span class="max-w-[120px] truncate">{pr.sourceBranch}</span>
				<span class="text-text-secondary">@{displayedRound.toSha.slice(0, 7)}</span>
			{:else}
				<span class="max-w-[120px] truncate">{pr.sourceBranch}</span>
				{#if pr.headSha}
					<span class="opacity-50">@{pr.headSha.slice(0, 7)}</span>
				{/if}
			{/if}
			<CaretUp size={10} class="shrink-0 opacity-60" />
		</button>
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			side="top"
			align="end"
			sideOffset={6}
			class="z-50 max-h-[60vh] min-w-[340px] overflow-y-auto overscroll-contain rounded-lg border border-border bg-bg-primary py-1 shadow-lg"
		>
			{#if listing.request.status === "loading" || listing.request.status === "idle"}
				<div class="flex items-center justify-center gap-2 px-3 py-3 text-xs text-text-muted">
					<Spinner size={12} class="motion-essential-spin" />
					<span>Loading commits…</span>
				</div>
			{:else if listing.request.status === "error"}
				<div class="flex items-center justify-center gap-2 px-3 py-3 text-xs text-danger">
					<WarningCircle size={12} weight="fill" />
					<span>Failed to load commits</span>
				</div>
			{:else if commits !== null}
				{#each commits as commit (commit.sha)}
					{@const isLatest = commit.sha === pr.headSha}
					{@const reports = reportsBySha.get(commit.sha) ?? []}
					{@const primary = reports[0]}
					{@const active = primary !== undefined && primary.walkthroughId === displayedWalkthroughId}
					{#snippet commitRow()}
						<div class="flex h-4 w-4 shrink-0 items-center justify-center">
							{#if isLatest}
								<div class="h-1.5 w-1.5 rounded-full bg-success"></div>
							{:else}
								<div class="h-1.5 w-1.5"></div>
							{/if}
						</div>
						<span class="shrink-0 font-mono text-xs text-text-muted">{commit.sha.slice(0, 7)}</span>
						<span class="flex-1 truncate {active ? 'text-text-primary' : 'text-text-secondary'}">
							{commit.message.split('\n')[0]?.slice(0, 48) ?? ''}
						</span>
						<span class="shrink-0 text-xs tabular-nums text-text-muted">
							{#if isLatest}
								<span class="italic">latest</span>
							{:else}
								{commit.date ? formatRelativeTime(commit.date) : ""}
							{/if}
						</span>
						<!-- walkthrough marker: the commit a report reviewed up to -->
						<span class="flex w-3 shrink-0 justify-end text-text-muted">
							{#if active}
								<Check size={12} class="text-text-primary" />
							{:else if primary}
								<Notebook size={12} />
							{/if}
						</span>
					{/snippet}
					{#if primary}
						<DropdownMenu.Item
							disabled={choosing}
							onSelect={() => chooseReport(primary)}
							title="View the walkthrough at this commit"
							class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs outline-none data-[highlighted]:bg-bg-elevated {active ? 'bg-bg-elevated' : ''}"
						>
							{@render commitRow()}
						</DropdownMenu.Item>
						{#each reports.slice(1) as round (round.id)}
							{@render reportRow(round, null)}
						{/each}
					{:else}
						<div class="flex items-center gap-2 px-3 py-1.5 text-xs outline-none">
							{@render commitRow()}
						</div>
					{/if}
				{/each}
				{#if orphanedReports.length > 0}
					<div class="mx-3 my-1 h-px bg-border"></div>
					<div class="px-3 py-1 text-[10px] uppercase tracking-wide text-text-muted">
						Walkthroughs of rewritten commits
					</div>
					{#each orphanedReports as round (round.id)}
						{@render reportRow(round, round.toSha)}
					{/each}
				{/if}
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
