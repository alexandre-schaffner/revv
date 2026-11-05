<script lang="ts">
import type { PrConversation, TimelineReview } from "@revv/shared";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import ChatCircleDots from "phosphor-svelte/lib/ChatCircleDots";
import Robot from "phosphor-svelte/lib/Robot";
import { SvelteSet } from "svelte/reactivity";
import Avatar from "$lib/components/shared/Avatar.svelte";
import { setActiveTab } from "$lib/stores/review.svelte";
import {
  commentGist,
  dayKey,
  dayLabel,
  groupTimeline,
  rowActor,
  rowTime,
  type TimelineRow,
} from "$lib/utils/conversation-timeline";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { openExternal } from "$lib/utils/open-external";
import CommentCard from "./CommentCard.svelte";
import MarkdownBody from "./MarkdownBody.svelte";
import TimelineCommits from "./TimelineCommits.svelte";
import TimelineEventLine from "./TimelineEventLine.svelte";
import VerdictGlyph from "./VerdictGlyph.svelte";

interface Props {
  conversation: PrConversation;
  canEdit: boolean;
  onEditComment: (commentId: number, body: string) => Promise<boolean>;
  onDeleteComment: (commentId: number) => Promise<boolean>;
  /** The viewer's last visit: rows from others after it are marked new. */
  freshSince?: string | null;
}

let { conversation, canEdit, onEditComment, onDeleteComment, freshSince = null }: Props = $props();

/** A run of more minor events than this folds its middle away. */
const EVENT_FOLD = 4;

const rows = $derived(groupTimeline(conversation.timeline));
const unfolded = new SvelteSet<string>();

interface Placed {
  readonly row: TimelineRow;
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
			<li class="timeline-bot" data-timeline-item>
				<span class="bot-icon"><Robot size={13} /></span>
				<p class="bot-text">
					<Avatar handle={item.author.login} avatarContent={item.author.avatarContent} size={16} />
					<strong>{item.author.login}</strong>
					<span class="bot-gist">{commentGist(item.body) || 'posted a comment'}</span>
				</p>
				<time datetime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
					{formatRelativeTime(item.createdAt)}
				</time>
				<button type="button" class="bot-open" onclick={() => unfolded.add(row.key)}>Show</button>
			</li>
		{:else if row.kind === 'comment'}
			{@const item = row.item}
			<li class="timeline-post" data-timeline-item>
				<CommentCard
					author={item.author}
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

	/* Comments get more air than event lines: they are the content the
	   activity is made of, the events its margin notes. */
	.timeline-post {
		position: relative;
		padding: 10px 0 12px;
	}

	.timeline-note,
	.timeline-fold {
		position: relative;
		padding: 2px 0 2px 34px;
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

	.review {
		padding: 5px 0;
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
	.timeline-bot {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		padding: 5px 0;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/* Same seat on the rail as an event line's glyph. */
	.bot-icon {
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

	.bot-text {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		margin: 0;
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

	.timeline-bot time {
		flex-shrink: 0;
		color: var(--color-text-muted);
	}

	.bot-open {
		flex-shrink: 0;
		margin-left: auto;
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
		font-size: var(--text-sm);
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
		width: fit-content;
		max-width: min(100% - 34px, 70ch + 32px);
		margin: 6px 0 4px 34px;
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
