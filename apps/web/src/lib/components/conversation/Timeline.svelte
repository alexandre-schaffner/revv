<script lang="ts">
import type { PrConversation } from "@revv/shared";
import { loginsMatch } from "@revv/shared";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import ChatCircleDots from "phosphor-svelte/lib/ChatCircleDots";
import { SvelteSet } from "svelte/reactivity";
import Avatar from "$lib/components/shared/Avatar.svelte";
import RelativeTime from "$lib/components/shared/RelativeTime.svelte";
import { groupTimeline } from "$lib/conversation/timeline";
import { VERDICT_VERB } from "$lib/conversation/verdict";
import { deleteComment, editComment, getAbilities } from "$lib/stores/conversation.svelte";
import { setActiveTab } from "$lib/stores/pr-view-state.svelte";
import { openExternal } from "$lib/utils/open-external";
import CommentCard from "./CommentCard.svelte";
import MarkdownBody from "./MarkdownBody.svelte";
import TimelineCommits from "./TimelineCommits.svelte";
import TimelineEventLine from "./TimelineEventLine.svelte";
import TimelineRow from "./TimelineRow.svelte";
import VerdictGlyph from "./VerdictGlyph.svelte";

interface Props {
  prId: string;
  conversation: PrConversation;
}

let { prId, conversation }: Props = $props();

const canComment = $derived(getAbilities(prId).canComment);

/** A run of more minor events than this folds its middle away. */
const EVENT_FOLD = 4;

const rows = $derived(groupTimeline(conversation.timeline));
const unfolded = new SvelteSet<string>();
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
			<li class="timeline-post">
				<CommentCard
					author={item.author}
					kind="comment"
					createdAt={item.createdAt}
					body={item.body}
					url={item.url}
					edited={item.edited}
					isAuthor={loginsMatch(item.author.login, conversation.author.login)}
					onsave={canComment && item.viewerCanUpdate
						? (body) => editComment(prId, item.databaseId, body)
						: undefined}
					ondelete={canComment && item.viewerCanDelete
						? () => deleteComment(prId, item.databaseId)
						: undefined}
				/>
			</li>
		{:else if row.kind === 'review'}
			{@const review = row.item}
			<TimelineRow>
				{#snippet glyph()}<VerdictGlyph verdict={review.verdict} size={14} />{/snippet}
				<p class="review-text">
					<Avatar name={review.author.login} src={review.author.avatarContent} size={16} />
					<strong>{review.author.login}</strong>
					{VERDICT_VERB[review.verdict]}
					<RelativeTime iso={review.createdAt} muted />
				</p>
				{#snippet actions()}
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
				{/snippet}
				{#snippet body()}
					{#if review.body.trim() || review.inlineCommentCount > 0}
						<div class="review-body">
							{#if review.body.trim()}
								<MarkdownBody source={review.body} />
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
				{/snippet}
			</TimelineRow>
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
		--rail-glyph: 24px;
		--rail-gap: 10px;
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
		left: calc(var(--rail-glyph) / 2 - 0.5px);
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
		padding: 2px 0 2px calc(var(--rail-glyph) + var(--rail-gap));
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

	.review-text {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 5px;
		margin: 0;
		padding-top: 2px;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.review-text strong {
		font-weight: 600;
		color: var(--color-text-primary);
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
		margin-top: 6px;
		padding: 10px 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-bg-primary);
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
