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
import { page } from "$app/state";
import { api } from "$lib/api/client";
import { setActiveTab } from "$lib/stores/review.svelte";
import { refreshPrHead } from "$lib/stores/sync.svelte";
import {
  getDisplayedWalkthroughId,
  getReviewRounds,
  loadReviewRounds,
  selectWalkthroughReport,
} from "$lib/stores/walkthrough.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { WALKTHROUGH_PERSPECTIVES } from "$lib/utils/walkthrough-perspective";

let { pr }: { pr: PullRequest } = $props();

type Commit = {
  sha: string;
  message: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  date: string | null;
};

let open = $state(false);
// Cache key is `prId@headSha`, not just `prId`: a head-SHA move makes the
// cached list wrong (it is missing the new commits and its "latest" marker
// points at a commit that is no longer the head), so the next open must refetch.
let cachedKey = $state<string | null>(null);
let commits = $state<Commit[] | null>(null);
let loading = $state(false);
let fetchError = $state(false);

// ── Walkthrough reports ─────────────────────────────────────────────────
//
// The commit list doubles as the walkthrough history: a commit that a
// walkthrough reviewed up to (`round.toSha`) is selectable and loads that
// report into the walkthrough tab. Only on the PR's own review page — that
// is where GuidedWalkthrough is mounted to render the pick.

const onReviewPage = $derived(page.params.prId === pr.id);
const displayedWalkthroughId = $derived(onReviewPage ? getDisplayedWalkthroughId(pr.id) : null);

// Newest first, so a commit's first report is the one its row opens. A run
// stopped or superseded before its overview has nothing to show, so it's left
// out rather than opening onto an empty page.
const reportRounds = $derived.by((): WalkthroughReviewRound[] => {
  if (!onReviewPage) return [];
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

function cacheKey(prId: string, headSha: string | null): string {
  return `${prId}@${headSha ?? ""}`;
}

function relativeDate(iso: string | null): string {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

async function fetchData(prId: string, headSha: string | null) {
  const key = cacheKey(prId, headSha);
  if (cachedKey === key) return;
  loading = true;
  fetchError = false;
  try {
    const res = await api.api.prs({ id: prId }).commits.get();
    const fetched = (res.data ?? []) as Commit[];
    commits = fetched;
    cachedKey = key;
    // This endpoint reads GitHub live and returns the PR's commits head-first,
    // so `fetched[0]` IS the real head. When it disagrees with the head we have
    // stored, the row is behind — the poll fiber hasn't caught this push yet —
    // and every head-derived affordance (the "Pull" button, the "latest" marker
    // below) is currently lying. Reconcile from the evidence already in hand
    // instead of waiting out the poll interval.
    const liveHead = fetched[0]?.sha;
    if (liveHead !== undefined && liveHead !== headSha) refreshPrHead(prId);
  } catch {
    fetchError = true;
  } finally {
    loading = false;
  }
}

$effect(() => {
  // Only `open` is tracked here. The PR is read via untrack so SSE-driven
  // PR object updates don't re-trigger a fetch while the dropdown is open.
  if (open) {
    const { id: prId, headSha } = untrack(() => ({ id: pr.id, headSha: pr.headSha }));
    if (cachedKey !== null && cachedKey !== cacheKey(prId, headSha)) {
      commits = null;
      cachedKey = null;
    }
    fetchData(prId, headSha);
    // Refresh the report list too: a round can finish while the menu is shut.
    if (untrack(() => onReviewPage)) void loadReviewRounds(prId);
  }
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
			{#if loading}
				<div class="flex items-center justify-center gap-2 px-3 py-3 text-xs text-text-muted">
					<Spinner size={12} class="motion-essential-spin" />
					<span>Loading commits…</span>
				</div>
			{:else if fetchError}
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
						<!-- dot indicator: green for the head commit, blank otherwise -->
						<div class="flex h-4 w-4 shrink-0 items-center justify-center">
							{#if isLatest}
								<div class="h-1.5 w-1.5 rounded-full bg-success"></div>
							{:else}
								<div class="h-1.5 w-1.5"></div>
							{/if}
						</div>
						<!-- short sha -->
						<span class="shrink-0 font-mono text-xs text-text-muted">{commit.sha.slice(0, 7)}</span>
						<!-- message -->
						<span class="flex-1 truncate {active ? 'text-text-primary' : 'text-text-secondary'}">
							{commit.message.split('\n')[0]?.slice(0, 48) ?? ''}
						</span>
						<!-- right label -->
						<span class="shrink-0 text-xs tabular-nums text-text-muted">
							{#if isLatest}
								<span class="italic">latest</span>
							{:else}
								{relativeDate(commit.date)}
							{/if}
						</span>
						<!-- walkthrough marker: the commit a report reviewed up to -->
						{#if onReviewPage}
							<span class="flex w-3 shrink-0 justify-end text-text-muted">
								{#if active}
									<Check size={12} class="text-text-primary" />
								{:else if primary}
									<Notebook size={12} />
								{/if}
							</span>
						{/if}
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
						<!-- Earlier runs that reviewed up to this same commit -->
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
