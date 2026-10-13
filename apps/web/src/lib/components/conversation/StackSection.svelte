<script lang="ts">
import {
  buildPullRequestDeepLink,
  type PrStack,
  type PrStackEntry,
  type StackEntryStatus,
} from "@revv/shared";
import CheckCircle from "phosphor-svelte/lib/CheckCircle";
import FileDashed from "phosphor-svelte/lib/FileDashed";
import GitMerge from "phosphor-svelte/lib/GitMerge";
import MinusCircle from "phosphor-svelte/lib/MinusCircle";
import XCircle from "phosphor-svelte/lib/XCircle";
import { openPrDeepLink } from "$lib/stores/pr-deep-link.svelte";
import { getPullRequests, getRepositories, getSelectedPr, selectPr } from "$lib/stores/prs.svelte";

// The stack this PR belongs to, top of the stack first and the base branch
// last, the way GitHub draws it: you read down toward what lands first.

interface Props {
  stack: PrStack;
  /** The PR on screen. */
  number: number;
}

let { stack, number }: Props = $props();

const STATUS_LABEL: Record<StackEntryStatus, string> = {
  merged: "Merged",
  closed: "Closed",
  draft: "Draft",
  ready: "Ready",
  not_ready: "Not ready",
};

const topFirst = $derived([...stack.entries].reverse());

/**
 * Open a stacked PR in Revv. One Revv already holds opens directly; any other
 * (a merged base, a PR the poll hasn't reached) goes through the deep-link
 * resolver, which fetches it from GitHub and opens it here. Never leaves the
 * app.
 */
function open(entry: PrStackEntry): void {
  const current = getSelectedPr();
  if (!current) return;
  const tracked = getPullRequests().find(
    (p) => p.repositoryId === current.repositoryId && p.externalId === entry.number,
  );
  if (tracked) {
    void selectPr(tracked.id);
    return;
  }
  const repository = getRepositories().find((r) => r.id === current.repositoryId);
  if (!repository) return;
  void openPrDeepLink(
    buildPullRequestDeepLink({
      githubHost: repository.githubHost,
      repositoryFullName: repository.fullName,
      number: entry.number,
    }),
  );
}
</script>

<section class="stack" aria-labelledby="side-stack">
	<header class="stack-head">
		<h3 id="side-stack">Stack #{stack.number}</h3>
		<span class="stack-count">{stack.entries.length} pull requests</span>
	</header>
	<ol class="stack-list">
		{#each topFirst as entry (entry.number)}
			{@const current = entry.number === number}
			<li class="stack-item">
				<button
					type="button"
					class="stack-entry"
					class:stack-entry--current={current}
					aria-current={current ? 'page' : undefined}
					disabled={current}
					onclick={() => open(entry)}
				>
					<span class="stack-glyph stack-glyph--{entry.status}" aria-hidden="true">
						{#if entry.status === 'merged'}
							<GitMerge size={14} weight="bold" />
						{:else if entry.status === 'closed'}
							<XCircle size={14} />
						{:else if entry.status === 'draft'}
							<FileDashed size={14} />
						{:else if entry.status === 'ready'}
							<CheckCircle size={14} weight="fill" />
						{:else}
							<MinusCircle size={14} weight="fill" />
						{/if}
					</span>
					<span class="stack-text">
						<span class="stack-title">{entry.title}</span>
						<span class="stack-meta">#{entry.number} · {entry.headRef}</span>
					</span>
					<span class="stack-status stack-status--{entry.status}">{STATUS_LABEL[entry.status]}</span>
				</button>
			</li>
		{/each}
		<li class="stack-item stack-base">
			<span class="stack-glyph stack-glyph--base" aria-hidden="true"></span>
			<code>{stack.baseRefName}</code>
		</li>
	</ol>
</section>

<style>
	.stack-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		min-height: 24px;
		margin-bottom: 6px;
	}

	.stack-head h3 {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--color-text-secondary);
	}

	.stack-count {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.stack-list {
		position: relative;
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The spine the entries hang on, base at the bottom. */
	.stack-list::before {
		content: "";
		position: absolute;
		top: 16px;
		bottom: 10px;
		left: 14.5px;
		width: 1px;
		background: var(--color-border);
	}

	.stack-entry {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border: none;
		border-radius: 6px;
		background: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.stack-entry:hover:not(:disabled) {
		background: var(--color-tree-hover-bg);
	}

	.stack-entry:disabled {
		cursor: default;
	}

	.stack-entry--current {
		background: var(--color-tree-active-bg);
	}

	.stack-glyph {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 14px;
		height: 18px;
		background: var(--color-bg-primary);
		border-radius: 50%;
	}

	.stack-entry--current .stack-glyph,
	.stack-entry:hover:not(:disabled) .stack-glyph {
		background: transparent;
	}

	.stack-glyph--merged {
		color: var(--color-merged);
	}

	.stack-glyph--closed {
		color: var(--color-danger);
	}

	.stack-glyph--draft {
		color: var(--color-text-muted);
	}

	.stack-glyph--ready {
		color: var(--color-success);
	}

	.stack-glyph--not_ready {
		color: var(--color-warning);
	}

	.stack-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
		min-width: 0;
	}

	.stack-title {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1.35;
		color: var(--color-text-primary);
	}

	.stack-entry--current .stack-title {
		color: var(--color-tree-active-text);
	}

	.stack-meta {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.stack-status {
		flex-shrink: 0;
		padding: 0 6px;
		border-radius: 999px;
		font-size: 0.6875rem;
		font-weight: 500;
		line-height: 18px;
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
	}

	.stack-status--merged {
		color: var(--color-merged);
		background: color-mix(in srgb, var(--color-merged) 12%, transparent);
	}

	.stack-status--ready {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
	}

	.stack-status--not_ready {
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
	}

	.stack-status--closed {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
	}

	.stack-base {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
	}

	.stack-glyph--base {
		width: 9px;
		height: 9px;
		margin: 0 2.5px;
		border: 1.5px solid var(--color-text-muted);
	}

	.stack-base code {
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}
</style>
