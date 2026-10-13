<script lang="ts">
import type { PrConversation, TimelineReview } from "@revv/shared";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import ChatCircleDots from "phosphor-svelte/lib/ChatCircleDots";
import { SvelteSet } from "svelte/reactivity";
import Avatar from "$lib/components/recaps/Avatar.svelte";
import { setActiveTab } from "$lib/stores/review.svelte";
import { groupTimeline } from "$lib/utils/conversation-timeline";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { renderMarkdown } from "$lib/utils/markdown";
import { interceptExternalLinks, openExternal } from "$lib/utils/open-external";
import CommentCard from "./CommentCard.svelte";
import TimelineCommits from "./TimelineCommits.svelte";
import TimelineEventLine from "./TimelineEventLine.svelte";
import VerdictGlyph from "./VerdictGlyph.svelte";

interface Props {
  conversation: PrConversation;
  canEdit: boolean;
  onEditComment: (commentId: number, body: string) => Promise<boolean>;
  onDeleteComment: (commentId: number) => Promise<boolean>;
}

let { conversation, canEdit, onEditComment, onDeleteComment }: Props = $props();

/** A run of more minor events than this folds its middle away. */
const EVENT_FOLD = 4;

const rows = $derived(groupTimeline(conversation.timeline));
const unfolded = new SvelteSet<string>();

const REVIEW_VERB: Record<TimelineReview["verdict"], string> = {
  approved: "approved these changes",
  changes_requested: "requested changes",
  commented: "reviewed",
  dismissed: "reviewed (dismissed)",
};
</script>

<ol class="timeline" aria-label="Pull request timeline">
	{#if conversation.timelineTruncated}
		<li class="timeline-note">
			Earlier activity is on
			<button type="button" onclick={() => void openExternal(conversation.url)}>GitHub</button>.
		</li>
	{/if}

	{#each rows as row (row.key)}
		{#if row.kind === 'comment'}
			{@const item = row.item}
			<li class="timeline-post" data-timeline-item>
				<CommentCard
					author={item.author}
					verb="commented"
					createdAt={item.createdAt}
					body={item.body}
					url={item.url}
					edited={item.edited}
					isAuthor={item.author.login === conversation.author.login}
					onsave={canEdit && item.viewerCanUpdate
						? (body) => onEditComment(item.databaseId, body)
						: undefined}
					ondelete={canEdit && item.viewerCanDelete
						? () => onDeleteComment(item.databaseId)
						: undefined}
				/>
			</li>
		{:else if row.kind === 'review'}
			{@const review = row.item}
			<li class="review" data-timeline-item>
				<div class="review-head">
					<span class="review-icon review-icon--{review.verdict}">
						<VerdictGlyph verdict={review.verdict} size={14} />
					</span>
					<p class="review-text">
						<Avatar handle={review.author.login} avatarContent={review.author.avatarContent} size={16} />
						<strong>{review.author.login}</strong>
						{REVIEW_VERB[review.verdict]}
						<time datetime={review.createdAt} title={new Date(review.createdAt).toLocaleString()}>
							{formatRelativeTime(review.createdAt)}
						</time>
					</p>
					{#if review.url}
						<button
							type="button"
							class="review-open"
							aria-label="Open review on GitHub"
							title="Open on GitHub"
							onclick={() => void openExternal(review.url)}
						>
							<ArrowSquareOut size={14} />
						</button>
					{/if}
				</div>
				{#if review.body.trim() || review.inlineCommentCount > 0}
					<div class="review-body">
						{#if review.body.trim()}
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div class="prose prose-sm prose-dense review-prose" onclick={interceptExternalLinks}>
								{@html renderMarkdown(review.body)}
							</div>
						{/if}
						{#if review.inlineCommentCount > 0}
							<button type="button" class="review-inline" onclick={() => setActiveTab('diff')}>
								<ChatCircleDots size={14} />
								{review.inlineCommentCount}
								{review.inlineCommentCount === 1 ? 'comment' : 'comments'} on the diff
							</button>
						{/if}
					</div>
				{/if}
			</li>
		{:else if row.kind === 'commits'}
			<TimelineCommits commits={row.commits} />
		{:else}
			{@const folded = row.lines.length > EVENT_FOLD && !unfolded.has(row.key)}
			{#each folded ? row.lines.slice(0, 2) : row.lines as line (line.key)}
				<TimelineEventLine {line} />
			{/each}
			{#if folded}
				<li class="timeline-fold">
					<button type="button" onclick={() => unfolded.add(row.key)}>
						Show {row.lines.length - 2} more events
					</button>
				</li>
			{/if}
		{/if}
	{/each}
</ol>

<style>
	.timeline {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The rail the event and commit glyphs sit on. */
	.timeline::before {
		content: "";
		position: absolute;
		top: 0;
		bottom: 0;
		left: 11.5px;
		width: 1px;
		background: var(--color-border);
	}

	.timeline-post {
		position: relative;
		padding: 6px 0;
	}

	.timeline-note,
	.timeline-fold {
		position: relative;
		padding: 2px 0 2px 34px;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.timeline-note button,
	.timeline-fold button {
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.timeline-note button:hover,
	.timeline-fold button:hover {
		color: var(--color-text-primary);
		text-decoration: underline;
	}

	.review {
		padding: 5px 0;
	}

	.review-head {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}

	.review-icon {
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
	}

	.review-text {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 5px;
		flex: 1;
		margin: 0;
		padding-top: 2px;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.review-text strong {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.review-text time {
		color: var(--color-text-muted);
	}

	.review-open {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.review-open:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}

	.review-body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 6px 0 0 34px;
		padding: 10px 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-bg-primary);
	}

	.review-prose {
		max-width: none;
		overflow-wrap: anywhere;
	}

	.review-inline {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		align-self: flex-start;
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.review-inline:hover {
		color: var(--color-text-primary);
		text-decoration: underline;
	}
</style>
