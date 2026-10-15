<script lang="ts">
import type { TimelineCommit } from "@revv/shared";
import CaretRight from "phosphor-svelte/lib/CaretRight";
import GitCommit from "phosphor-svelte/lib/GitCommit";
import SealCheck from "phosphor-svelte/lib/SealCheck";
import { SvelteSet } from "svelte/reactivity";
import Avatar from "$lib/components/shared/Avatar.svelte";
import { gsapSlide } from "$lib/motion";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { openExternal } from "$lib/utils/open-external";
import CiGlyph, { bucketOfRollup } from "./CiGlyph.svelte";

interface Props {
  commits: readonly TimelineCommit[];
}

let { commits }: Props = $props();

/** Commits whose full message is open. Local UI state, per mount. */
const open = new SvelteSet<string>();

const authors = $derived([...new Set(commits.map((c) => c.author.login))]);
const first = $derived(commits[0]);

function toggle(sha: string): void {
  if (open.has(sha)) open.delete(sha);
  else open.add(sha);
}
</script>

<li class="commits">
	<div class="commits-head">
		<span class="commits-icon" aria-hidden="true"><GitCommit size={14} weight="bold" /></span>
		<p class="commits-text">
			{#if first}
				<Avatar handle={first.author.login} avatarContent={first.author.avatarContent} size={16} />
			{/if}
			<strong>{authors.length === 1 ? authors[0] : `${authors.length} people`}</strong>
			added {commits.length === 1 ? 'a commit' : `${commits.length} commits`}
			{#if first}
				<time datetime={first.createdAt} title={new Date(first.createdAt).toLocaleString()}>
					{formatRelativeTime(first.createdAt)}
				</time>
			{/if}
		</p>
	</div>

	<ul class="commit-list">
		{#each commits as commit (commit.id)}
			{@const bucket = bucketOfRollup(commit.ci)}
			{@const expandable = commit.messageBody.trim().length > 0}
			<li class="commit">
				<div class="commit-row">
					<span class="commit-ci">
						{#if bucket}<CiGlyph {bucket} size={14} />{/if}
					</span>
					{#if expandable}
						<button
							type="button"
							class="commit-headline commit-headline--button"
							aria-expanded={open.has(commit.sha)}
							onclick={() => toggle(commit.sha)}
						>
							<span class="commit-caret" class:commit-caret--open={open.has(commit.sha)}>
								<CaretRight size={10} weight="bold" />
							</span>
							<span class="commit-title">{commit.headline}</span>
						</button>
					{:else}
						<span class="commit-headline"><span class="commit-title">{commit.headline}</span></span>
					{/if}
					{#if commit.verified}
						<span class="commit-verified" title="Signature verified by GitHub">
							<SealCheck size={13} weight="fill" />
							Verified
						</span>
					{/if}
					<button
						type="button"
						class="commit-sha"
						title="Open on GitHub"
						onclick={() => void openExternal(commit.url)}
					>
						{commit.sha.slice(0, 7)}
					</button>
				</div>
				{#if open.has(commit.sha)}
					<pre class="commit-body" transition:gsapSlide>{commit.messageBody}</pre>
				{/if}
			</li>
		{/each}
	</ul>
</li>

<style>
	.commits {
		padding: 5px 0;
	}

	.commits-head {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}

	.commits-icon {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--color-bg-secondary);
		box-shadow: 0 0 0 3px var(--color-bg-primary);
		color: var(--color-text-secondary);
	}

	.commits-text {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 5px;
		margin: 0;
		padding-top: 2px;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.commits-text strong {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.commits-text time {
		color: var(--color-text-muted);
	}

	.commit-list {
		margin: 4px 0 0 34px;
		padding: 0;
		list-style: none;
	}

	.commit-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 28px;
	}

	.commit-ci {
		display: inline-flex;
		width: 14px;
		flex-shrink: 0;
	}

	.commit-headline {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1;
		min-width: 0;
		font-size: 0.8125rem;
		color: var(--color-text-primary);
	}

	.commit-headline--button {
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		font-size: 0.8125rem;
		text-align: left;
		cursor: pointer;
	}

	.commit-headline--button:hover .commit-title {
		text-decoration: underline;
	}

	.commit-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.commit-caret {
		display: inline-flex;
		color: var(--color-text-muted);
		transition: rotate var(--duration-snap) var(--ease-soft);
	}

	.commit-caret--open {
		rotate: 90deg;
	}

	.commit-verified {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		flex-shrink: 0;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-success);
	}

	.commit-sha {
		flex-shrink: 0;
		padding: 1px 4px;
		border: none;
		border-radius: 4px;
		background: none;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.commit-sha:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.commit-body {
		margin: 2px 0 8px 22px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--color-bg-secondary);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
