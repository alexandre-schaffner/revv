<script lang="ts">
	import { untrack } from 'svelte';
	import { DropdownMenu } from 'bits-ui';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Loader from '@lucide/svelte/icons/loader';
	import type { PullRequest } from '@revv/shared';
	import { api } from '$lib/api/client';

	let { pr }: { pr: PullRequest } = $props();

	type Commit = {
		sha: string;
		message: string;
		authorLogin: string | null;
		authorAvatarUrl: string | null;
		date: string | null;
	};

	let open = $state(false);
	let cachedPrId = $state<string | null>(null);
	let commits = $state<Commit[] | null>(null);
	let loading = $state(false);

	function relativeDate(iso: string | null): string {
		if (!iso) return '';
		const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	async function fetchData(prId: string) {
		const needsCommits = cachedPrId !== prId;
		if (!needsCommits) return;
		loading = true;
		try {
			const res = await api.api.prs({ id: prId }).commits.get();
			// Server returns commits topologically sorted newest-first (head at
			// index 0, oldest last), walked along the first-parent chain. We
			// display as-is — no client-side sorting. Author/committer dates are
			// unreliable after rebase/cherry-pick/amend, and GitHub's API response
			// order is not stable either; that's why the server does the work.
			commits = (res.data ?? []) as Commit[];
			cachedPrId = prId;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		// Only `open` is tracked here. pr.id is read via untrack so WS-driven
		// PR object updates don't re-trigger a fetch while the dropdown is open.
		if (open) {
			const prId = untrack(() => pr.id);
			if (cachedPrId !== null && cachedPrId !== prId) {
				commits = null;
				cachedPrId = null;
			}
			fetchData(prId);
		}
	});
</script>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger>
		<button
			class="flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-secondary"
		>
			<span class="max-w-[120px] truncate">{pr.sourceBranch}</span>
			{#if pr.headSha}
				<span class="opacity-50">@{pr.headSha.slice(0, 7)}</span>
			{/if}
			<ChevronUp size={10} class="shrink-0 opacity-60" />
		</button>
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			side="top"
			align="end"
			sideOffset={6}
			class="z-50 min-w-[340px] rounded-lg border border-border bg-bg-primary py-1 shadow-lg"
		>
			{#if loading}
				<div class="flex items-center justify-center gap-2 px-3 py-3 text-xs text-text-muted">
					<span class="animate-spin"><Loader size={12} /></span>
					<span>Loading commits…</span>
				</div>
			{:else if commits !== null}
				{#each commits.slice(0, 10) as commit (commit.sha)}
					{@const isLatest = commit.sha === pr.headSha}
					<div
						class="flex items-center gap-2 px-3 py-1.5 text-xs outline-none"
					>
						<!-- dot indicator: green for the head commit, blank otherwise -->
						<div class="flex h-4 w-4 shrink-0 items-center justify-center">
							{#if isLatest}
								<div class="h-1.5 w-1.5 rounded-full bg-green-500"></div>
							{:else}
								<div class="h-1.5 w-1.5"></div>
							{/if}
						</div>
						<!-- short sha -->
						<span class="shrink-0 font-mono text-[10px] text-text-muted">{commit.sha.slice(0, 7)}</span>
						<!-- message -->
						<span class="flex-1 truncate text-text-secondary">
							{commit.message.split('\n')[0]?.slice(0, 48) ?? ''}
						</span>
						<!-- right label -->
						<span class="shrink-0 text-[10px] text-text-muted">
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
