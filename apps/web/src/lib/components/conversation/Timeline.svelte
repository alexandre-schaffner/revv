<script lang="ts">
import type { PrConversation } from "@revv/shared";
import { loginsMatch } from "@revv/shared";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import ChatCircleDots from "phosphor-svelte/lib/ChatCircleDots";
import Robot from "phosphor-svelte/lib/Robot";
import { SvelteSet } from "svelte/reactivity";
import Markdown from "$lib/components/markdown/Markdown.svelte";
import Avatar from "$lib/components/shared/Avatar.svelte";
import RelativeTime from "$lib/components/shared/RelativeTime.svelte";
import {
  commentGist,
  dayKey,
  dayLabel,
  groupTimeline,
  type TimelineRow as Row,
  rowActor,
  rowTime,
} from "$lib/conversation/timeline";
import { VERDICT_VERB } from "$lib/conversation/verdict";
import { deleteComment, editComment, getAbilities } from "$lib/stores/conversation.svelte";
import { setActiveTab } from "$lib/stores/pr-view-state.svelte";
import { openExternal } from "$lib/utils/open-external";
import CommentCard from "./CommentCard.svelte";
import TimelineCommits from "./TimelineCommits.svelte";
import TimelineEventLine from "./TimelineEventLine.svelte";
import TimelineRow from "./TimelineRow.svelte";
import VerdictGlyph from "./VerdictGlyph.svelte";

interface Props {
  prId: string;
  conversation: PrConversation;
  /** The viewer's last visit: rows from others after it are marked new. */
  freshSince?: string | null;
}

let { prId, conversation, freshSince = null }: Props = $props();

const canComment = $derived(getAbilities(prId).canComment);

/** A run of more minor events than this folds its middle away. */
const EVENT_FOLD = 4;

const rows = $derived(groupTimeline(conversation.timeline));
const unfolded = new SvelteSet<string>();

interface Placed {
  readonly row: Row;
  /** Set on the first row of each calendar day. */
  readonly day: string | null;
  /** The first row the viewer hasn't seen: the "new" rule goes above it. */
  readonly firstFresh: boolean;
}

const placed = $derived.by((): Placed[] => {
  const cutoff = freshSince ? Date.parse(freshSince) : null;
  const me = conversation.viewerLogin.toLowerCase();
  let previousDay = "";
  let freshFound = false;
  return rows.map((row) => {
    const at = rowTime(row);
    const key = dayKey(at);
    const day = key === previousDay ? null : dayLabel(at);
    previousDay = key;
    const fresh =
      !freshFound &&
      cutoff !== null &&
      Date.parse(at) > cutoff &&
      rowActor(row).toLowerCase() !== me;
    if (fresh) freshFound = true;
    return { row, day, firstFresh: fresh };
  });
});
</script>

<ol class="timeline" aria-label="Pull request timeline">
	{#if conversation.timelineTruncated}
		<li class="timeline-note">
			Earlier activity is on
			<button type="button" onclick={() => void openExternal(conversation.url)}>GitHub</button>.
		</li>
	{/if}

	{#each placed as { row, day, firstFresh } (row.key)}
		{#if day}
			<li class="timeline-rule timeline-rule--day"><span>{day}</span></li>
		{/if}
		{#if firstFresh}
			<li class="timeline-rule timeline-rule--new" data-fresh><span>New since your last visit</span></li>
		{/if}
		{#if row.kind === 'comment' && row.item.author.kind === 'bot' && !unfolded.has(row.key)}
			{@const item = row.item}
			<!-- Bots post reports; the report's title is the line, the report a click away. -->
			<TimelineRow>
				{#snippet glyph()}<Robot size={13} />{/snippet}
				<p class="bot-text">
					<Avatar name={item.author.login} src={item.author.avatarContent} size={16} />
					<strong>{item.author.login}</strong>
					<span class="bot-gist">{commentGist(item.body) || 'posted a comment'}</span>
					<RelativeTime iso={item.createdAt} muted />
				</p>
				{#snippet actions()}
					<button type="button" class="bot-open" onclick={() => unfolded.add(row.key)}>Show</button>
				{/snippet}
			</TimelineRow>
		{:else if row.kind === 'comment'}
			{@const item = row.item}
			<li class="timeline-post">
				<CommentCard
					author={item.author}
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
								<Markdown source={review.body} trust="external" density="dense" class="wrap-anywhere" />
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

	/* Comments get more air than event lines: they are the content the
	   activity is made of, the events its margin notes. */
	.timeline-post {
		position: relative;
		padding: 10px 0 12px;
	}

	.timeline-note,
	.timeline-fold {
		position: relative;
		padding: 2px 0 2px calc(var(--rail-glyph) + var(--rail-gap));
		font-size: var(--text-sm);
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

	/* ── Day and "new" rules ────────────────────────────────────────
	   The label sits on the rail (its paper hides the line behind it); a
	   hairline runs on to the edge, so a long history reads in days. */
	.timeline-rule {
		position: relative;
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
		font-size: var(--text-ui);
		letter-spacing: var(--text-ui--letter-spacing);
		font-weight: 500;
		color: var(--color-text-subtle);
	}

	.timeline-rule:first-child {
		margin-top: 0;
	}

	.timeline-rule > span {
		padding: 2px 8px 2px 0;
		background: var(--color-bg-primary);
	}

	.timeline-rule::after {
		content: "";
		flex: 1;
		height: 1px;
		background: var(--color-border-subtle);
	}

	.timeline-rule--new {
		margin-top: 2px;
		color: var(--color-accent);
		scroll-margin-top: 96px;
	}

	.timeline-rule--new::after {
		background: color-mix(in srgb, var(--color-accent) 45%, transparent);
	}

	/* ── Bot reports, folded to a line ──────────────────────────────── */
	.bot-text {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		margin: 0;
		padding-top: 2px;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.bot-text strong {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.bot-gist {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bot-text :global(time) {
		flex-shrink: 0;
	}

	.bot-open {
		flex-shrink: 0;
		padding: 1px 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: none;
		font: inherit;
		font-size: var(--text-ui);
		letter-spacing: var(--text-ui--letter-spacing);
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.bot-open:hover {
		border-color: var(--color-text-muted);
		color: var(--color-text-primary);
	}

	.review-text {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 5px;
		margin: 0;
		padding-top: 2px;
		font-size: var(--text-sm);
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
		width: fit-content;
		max-width: min(100%, 70ch + 32px);
		margin: 6px 0 4px;
		padding: 12px 16px;
		border-radius: 4px 16px 16px;
		background: color-mix(in srgb, var(--color-bg-secondary) 60%, var(--color-bg-tertiary));
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
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.review-inline:hover {
		color: var(--color-text-primary);
		text-decoration: underline;
	}
</style>
