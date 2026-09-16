<script lang="ts">
import type { PullRequest } from "@revv/shared";
import { DropdownMenu } from "bits-ui";
import CaretUp from "phosphor-svelte/lib/CaretUp";
import Spinner from "phosphor-svelte/lib/Spinner";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import { untrack } from "svelte";
import { api } from "$lib/api/client";
import { refreshPrHead } from "$lib/stores/sync.svelte";

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
  }
});
</script>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger>
		<button
			class="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-mono text-xs text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-secondary"
		>
			<span class="max-w-[120px] truncate">{pr.sourceBranch}</span>
			{#if pr.headSha}
				<span class="opacity-50">@{pr.headSha.slice(0, 7)}</span>
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
					<div
						class="flex items-center gap-2 px-3 py-1.5 text-xs outline-none"
					>
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
						<span class="flex-1 truncate text-text-secondary">
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
					</div>
				{/each}
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
