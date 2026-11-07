<script lang="ts">
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import { untrack } from "svelte";
import YourReview from "$lib/components/review/YourReview.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { prefersReducedMotion } from "$lib/motion";
import { useCommands } from "$lib/stores/commands.svelte";
import {
  editBody,
  getAbilities,
  getConversation,
  loadConversation,
  postComment,
  watchConversation,
} from "$lib/stores/conversation.svelte";
import { getActivePanel } from "$lib/stores/focus-mode.svelte";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { openExternal } from "$lib/utils/open-external";
import BaseConflicts from "./BaseConflicts.svelte";
import CiChecks from "./CiChecks.svelte";
import CommentCard from "./CommentCard.svelte";
import ConversationSidebar from "./ConversationSidebar.svelte";
import MarkdownEditor from "./MarkdownEditor.svelte";
import Timeline from "./Timeline.svelte";

interface Props {
  prId: string;
  isActive: boolean;
}

let { prId, isActive }: Props = $props();

const entry = $derived(getConversation(prId));
const conversation = $derived(entry.request.status === "ok" ? entry.request.data : null);
const abilities = $derived(getAbilities(prId));

let composer = $state<HTMLTextAreaElement | null>(null);
let reviewersOpen = $state(false);
let assigneesOpen = $state(false);
let labelsOpen = $state(false);

$effect(() => {
  if (!isActive || !prId) return;
  const id = prId;
  return untrack(() => watchConversation(id));
});

// The sidebar's file tree binds the same letters (`l` opens a file).
const keysLive = (): boolean => isActive && conversation !== null && getActivePanel() !== "sidebar";
const canEdit = (): boolean => keysLive() && abilities.canEdit;

function focusComposer(): void {
  if (!composer) return;
  composer.focus();
  composer.scrollIntoView({
    block: "center",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

useCommands([
  {
    id: "conversation:comment",
    label: "Write a comment",
    keys: { bare: ["c", "C"] },
    when: () => keysLive() && abilities.canComment && composer !== null,
    hidden: true,
    run: focusComposer,
  },
  {
    id: "conversation:reviewers",
    label: "Edit reviewers",
    keys: { bare: ["r", "R"] },
    when: canEdit,
    hidden: true,
    run: () => {
      reviewersOpen = true;
    },
  },
  {
    id: "conversation:assignees",
    label: "Edit assignees",
    keys: { bare: ["a", "A"] },
    when: canEdit,
    hidden: true,
    run: () => {
      assigneesOpen = true;
    },
  },
  {
    id: "conversation:labels",
    label: "Edit labels",
    keys: { bare: ["l", "L"] },
    when: canEdit,
    hidden: true,
    run: () => {
      labelsOpen = true;
    },
  },
]);
</script>

<div class="conversation review-columns">
	<div class="conversation-main">
		{#if conversation}
			{#if entry.stale}
				<p class="conversation-stale" role="status">
					GitHub couldn't be reached. Showing the copy from {formatRelativeTime(conversation.fetchedAt)}.
					<Button variant="ghost" size="xs" onclick={() => void loadConversation(prId, { force: true })}>
						<ArrowClockwise />Retry
					</Button>
				</p>
			{/if}

			<div class="slot-description">
				<CommentCard
					author={conversation.author}
					kind="description"
					createdAt={conversation.createdAt}
					body={conversation.body}
					url={conversation.url}
					emptyText="No description provided."
					onsave={abilities.canEdit ? (body) => editBody(prId, body) : undefined}
				/>
			</div>


			<div class="slot-timeline">
				<Timeline {prId} {conversation} />
			</div>

			<!-- Where CI stands now, after the history that led here: GitHub's merge
			     box sits in the same place. Each commit above carries its own CI
			     state in the timeline. -->
			<div class="slot-checks">
				<CiChecks {prId} {conversation} />
			</div>

			<!-- The other half of GitHub's merge box: conflicts with the base. -->
			<div class="slot-conflicts">
				<BaseConflicts {prId} {conversation} />
			</div>

			{#if abilities.canComment && conversation.state === 'open'}
				<div class="slot-composer">
					<MarkdownEditor
						placeholder="Add a comment"
						submitLabel="Comment"
						onsubmit={(body) => postComment(prId, body)}
						bind:textarea={composer}
					/>
				</div>
			{/if}
		{:else if entry.request.status === 'error'}
			<div class="conversation-error" role="alert">
				<p>Couldn't load the conversation: {entry.request.error}</p>
				<div class="conversation-error-actions">
					<Button variant="outline" size="sm" onclick={() => void loadConversation(prId, { force: true })}>
						<ArrowClockwise />Retry
					</Button>
				</div>
			</div>
		{:else}
			<div class="conversation-skeleton" aria-busy="true" aria-label="Loading conversation">
				<div class="skeleton-card">
					<span class="skeleton-line skeleton-line--head"></span>
					<span class="skeleton-line"></span>
					<span class="skeleton-line skeleton-line--short"></span>
				</div>
				<div class="skeleton-card skeleton-card--low"><span class="skeleton-line skeleton-line--head"></span></div>
				<span class="skeleton-line skeleton-line--event"></span>
				<span class="skeleton-line skeleton-line--event"></span>
			</div>
		{/if}

		<section class="slot-review" aria-labelledby="your-review-heading">
			<h2 id="your-review-heading" class="review-heading">Your review</h2>
			<YourReview {prId} />
		</section>
	</div>

	<aside class="conversation-side" data-col="rail" aria-label="Pull request details">
		{#if conversation}
			<ConversationSidebar
				{prId}
				{conversation}
				bind:reviewersOpen
				bind:assigneesOpen
				bind:labelsOpen
			/>
			<button type="button" class="side-github" onclick={() => void openExternal(conversation.url)}>
				<ArrowSquareOut size={13} />
				Open on GitHub
			</button>
		{/if}
	</aside>
</div>

<style>
	/* The review grid (review-columns.css): the timeline in the content
	   column, the sidebar in the rail. */
	.conversation {
		align-items: start;
		/* Clears the floating review action bar. */
		padding: 16px 0 100px;
		background: var(--color-bg-primary);
	}

	.slot-conflicts:empty {
		display: none;
	}

	.conversation-main {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
	}

	.conversation-side {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		padding-top: 4px;
	}

	.slot-review {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 16px;
		padding-top: 24px;
		border-top: 1px solid var(--color-border);
	}

	.review-heading {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.conversation-stale {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		padding: 6px 6px 6px 12px;
		border-radius: var(--radius-card);
		background: color-mix(in srgb, var(--color-warning) 8%, transparent);
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.conversation-error {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.conversation-error p {
		margin: 0;
	}

	.conversation-error-actions {
		display: flex;
		gap: 8px;
	}

	.conversation-skeleton {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.skeleton-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px;
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-card);
	}

	.skeleton-card--low {
		padding: 14px 16px;
	}

	.skeleton-line {
		display: block;
		height: 10px;
		border-radius: 4px;
		background: var(--color-bg-tertiary);
	}

	.skeleton-line--head {
		width: 40%;
	}

	.skeleton-line--short {
		width: 60%;
	}

	.skeleton-line--event {
		width: 50%;
		margin-left: 34px;
	}

	.side-github {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		padding: 8px 0 0;
		border: none;
		border-top: 1px solid var(--color-border-subtle);
		background: none;
		width: 100%;
		font: inherit;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.side-github:hover {
		color: var(--color-text-primary);
	}

	/* Narrow main area: one column. The main column dissolves into the flex
	   flow so the sidebar can slot in right under the description, where
	   GitHub's mobile layout puts it. Gated on `.review-content`'s width,
	   not the viewport (the sidebar and right panel both move it). */
	@container review (max-width: 1335px) {
		/* Left edge pinned at col_3's x (72px), like the title and the
		   walkthrough's narrow layout, so all three stay aligned. */
		.conversation {
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 16px;
			max-width: calc(72px + 820px + 32px);
			margin-inline: 0;
			padding: 16px 32px 100px 72px;
			box-sizing: border-box;
		}

		.conversation-main {
			display: contents;
		}

		.slot-description,
		.conversation-stale {
			order: 0;
		}

		.conversation-side {
			order: 1;
			container: side / inline-size;
			padding: 12px 14px;
			border: 1px solid var(--color-border-subtle);
			border-radius: var(--radius-card);
			background: var(--color-bg-secondary);
		}

		.slot-checks,
		.slot-conflicts,
		.slot-timeline,
		.slot-composer,
		.slot-review,
		.conversation-error,
		.conversation-skeleton {
			order: 2;
		}
	}
</style>
