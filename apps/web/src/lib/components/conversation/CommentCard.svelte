<script lang="ts">
import type { ConversationActor } from "@revv/shared";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import PencilSimple from "phosphor-svelte/lib/PencilSimple";
import Trash from "phosphor-svelte/lib/Trash";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import Avatar from "$lib/components/shared/Avatar.svelte";
import RelativeTime from "$lib/components/shared/RelativeTime.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { openExternal } from "$lib/utils/open-external";
import MarkdownEditor from "./MarkdownEditor.svelte";

// A markdown post in the conversation: the PR description or a comment.
// Editing swaps the body for the editor in place.

interface Props {
  author: ConversationActor;
  kind: "description" | "comment";
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
  kind,
  createdAt,
  body,
  url,
  edited = false,
  emptyText,
  isAuthor = false,
  onsave,
  ondelete,
}: Props = $props();

/** A description may be emptied; a comment may not. */
const POST = {
  description: { verb: "opened", placeholder: "Describe this pull request", allowEmpty: true },
  comment: { verb: "commented", placeholder: "Edit your comment", allowEmpty: false },
} as const;
const post = $derived(POST[kind]);

let editing = $state(false);
let confirmingDelete = $state(false);

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

<article class="card">
	<header class="card-head">
		<Avatar name={author.login} src={author.avatarContent} size={22} />
		<p class="card-byline">
			<span class="card-author">{author.login}</span>
			{#if author.kind === 'bot'}<span class="card-tag">bot</span>{/if}
			{#if isAuthor}<span class="card-tag">author</span>{/if}
			<span class="card-verb">{post.verb}</span>
			<RelativeTime iso={createdAt} />
			{#if edited}<span class="card-verb">· edited</span>{/if}
		</p>
		<div class="card-actions">
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
		<div class="card-editor">
			<MarkdownEditor
				initial={body}
				placeholder={post.placeholder}
				submitLabel="Save"
				allowEmpty={post.allowEmpty}
				autofocus
				onsubmit={save}
				oncancel={() => (editing = false)}
			/>
		</div>
	{:else if body.trim()}
		<div class="card-body"><Markdown source={body} trust="external" density="dense" class="wrap-anywhere" /></div>
	{:else if emptyText}
		<p class="card-body card-empty">{emptyText}</p>
	{/if}
</article>

<style>
	.card {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-bg-primary);
		min-width: 0;
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 6px 8px 6px 12px;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-bg-secondary);
		border-radius: var(--radius-card) var(--radius-card) 0 0;
	}

	.card-byline {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0 5px;
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.card-author {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.card-tag {
		padding: 0 5px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font-size: 0.6875rem;
		line-height: 16px;
		color: var(--color-text-secondary);
	}

	.card-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}

	.card-body {
		padding: 12px 16px 14px;
	}

	.card-empty {
		margin: 0;
		font-size: 0.875rem;
		font-style: italic;
		color: var(--color-text-muted);
	}

	.card-editor {
		padding: 10px;
	}
</style>
