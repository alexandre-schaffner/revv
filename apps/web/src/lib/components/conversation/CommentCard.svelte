<script lang="ts">
import type { ConversationActor } from "@revv/shared";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import PencilSimple from "phosphor-svelte/lib/PencilSimple";
import Trash from "phosphor-svelte/lib/Trash";
import Avatar from "$lib/components/shared/Avatar.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { openExternal } from "$lib/utils/open-external";
import MarkdownBody from "./MarkdownBody.svelte";
import MarkdownEditor from "./MarkdownEditor.svelte";

interface Props {
  author: ConversationActor;
  createdAt: string;
  body: string;
  url: string;
  edited?: boolean;
  /** Shown in place of an empty body. */
  emptyText?: string;
  /** Marks the PR author's own comments, as GitHub does. */
  isAuthor?: boolean;
  onsave?: ((body: string) => Promise<boolean>) | undefined;
  ondelete?: (() => Promise<boolean>) | undefined;
}

let {
  author,
  createdAt,
  body,
  url,
  edited = false,
  emptyText,
  isAuthor = false,
  onsave,
  ondelete,
}: Props = $props();

let editing = $state(false);
let confirmingDelete = $state(false);

const absolute = $derived(new Date(createdAt).toLocaleString());

async function save(next: string): Promise<boolean> {
  if (!onsave) return false;
  const landed = await onsave(next);
  if (landed) editing = false;
  return landed;
}

async function confirmDelete(): Promise<void> {
  if (!ondelete) return;
  confirmingDelete = false;
  await ondelete();
}
</script>

<article class="comment">
	<header class="comment-head">
		<span class="comment-avatar">
			<Avatar handle={author.login} avatarContent={author.avatarContent} size={24} />
		</span>
		<p class="comment-byline">
			<span class="comment-author">{author.login}</span>
			{#if author.kind === 'bot'}<span class="comment-tag">bot</span>{/if}
			{#if isAuthor}<span class="comment-tag">author</span>{/if}
			<time datetime={createdAt} title={absolute}>{formatRelativeTime(createdAt)}</time>
			{#if edited}<span>· edited</span>{/if}
		</p>
		<div class="comment-actions" class:comment-actions--pinned={confirmingDelete}>
			{#if confirmingDelete}
				<Button variant="destructive" size="xs" onclick={() => void confirmDelete()}>
					Delete comment
				</Button>
				<Button variant="ghost" size="xs" onclick={() => (confirmingDelete = false)}>Keep</Button>
			{:else}
				{#if onsave && !editing}
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Edit"
						title="Edit"
						onclick={() => (editing = true)}
					>
						<PencilSimple />
					</Button>
				{/if}
				{#if ondelete && !editing}
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Delete"
						title="Delete"
						onclick={() => (confirmingDelete = true)}
					>
						<Trash />
					</Button>
				{/if}
				{#if url}
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Open on GitHub"
						title="Open on GitHub"
						onclick={() => void openExternal(url)}
					>
						<ArrowSquareOut />
					</Button>
				{/if}
			{/if}
		</div>
	</header>

	{#if editing && onsave}
		<div class="comment-body comment-body--editing">
			<MarkdownEditor
				initial={body}
				placeholder="Edit your comment"
				submitLabel="Save"
				autofocus
				onsubmit={save}
				oncancel={() => (editing = false)}
			/>
		</div>
	{:else if body.trim()}
		<div class="comment-body"><MarkdownBody source={body} /></div>
	{:else if emptyText}
		<p class="comment-body comment-empty">{emptyText}</p>
	{/if}
</article>

<style>
	.comment {
		min-width: 0;
	}

	/* Same geometry as an event line: a 24px node on the rail, its text
	   10px to the right, so a comment's byline reads as one more line of the
	   activity rather than the top of a box. */
	.comment-head {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 28px;
	}

	.comment-avatar {
		position: relative;
		z-index: 1;
		display: grid;
		flex-shrink: 0;
		border-radius: 50%;
		box-shadow: 0 0 0 3px var(--color-bg-primary);
	}

	.comment-byline {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0 6px;
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 13px;
		color: var(--color-text-muted);
	}

	.comment-author {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.comment-tag {
		padding: 0 5px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
		font-size: 0.6875rem;
		line-height: 16px;
		color: var(--color-text-secondary);
	}

	/* Chrome stays out of the reading until the pointer or focus is on the
	   comment; a pending delete confirmation holds it open. */
	.comment-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
		color: var(--color-text-muted);
		opacity: 0;
	}

	.comment:hover .comment-actions,
	.comment:focus-within .comment-actions,
	.comment-actions--pinned {
		opacity: 1;
	}

	.comment-body {
		width: fit-content;
		max-width: min(100% - 34px, 70ch + 32px);
		margin: 6px 0 0 34px;
		padding: 12px 16px;
		border-radius: 4px 16px 16px;
		background: color-mix(in srgb, var(--color-bg-secondary) 60%, var(--color-bg-tertiary));
	}

	.comment-body--editing {
		width: auto;
		max-width: none;
		padding: 0;
		border-radius: 0;
		background: none;
	}

	.comment-empty {
		font-size: 14px;
		font-style: italic;
		color: var(--color-text-muted);
	}

	@media (hover: none) {
		.comment-actions {
			opacity: 1;
		}
	}
</style>
