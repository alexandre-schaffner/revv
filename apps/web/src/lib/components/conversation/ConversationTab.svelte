<script lang="ts">
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import { onMount, untrack } from "svelte";
import YourReview from "$lib/components/review/YourReview.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import {
  changeAssignees,
  changeLabels,
  changeReviewers,
  deleteComment,
  editBody,
  editComment,
  getConversation,
  hasPendingChecks,
  loadCheckDetails,
  loadConversation,
  postComment,
  rerunFailedRuns,
  rerunJob,
  watchChecks,
} from "$lib/stores/conversation.svelte";
import { getActivePanel } from "$lib/stores/focus-mode.svelte";
import { isTextEditingKeyTarget } from "$lib/utils";
import { formatRelativeTime } from "$lib/utils/format-relative-time";
import { openExternal } from "$lib/utils/open-external";
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
const canEdit = $derived(!!conversation?.viewerCanUpdate && !entry.denied.has("edit"));
const canComment = $derived(!entry.denied.has("edit"));
const canRerun = $derived(!!conversation?.viewerCanPush && !entry.denied.has("rerun"));
const shouldPollChecks = $derived(
  isActive && (hasPendingChecks(conversation?.ci) || entry.awaitingRerun),
);

let composer = $state<HTMLTextAreaElement | null>(null);
let reviewersOpen = $state(false);
let assigneesOpen = $state(false);
let labelsOpen = $state(false);

// Load when the tab comes on screen; the store skips a fetch younger than 30s.
// `untrack` keeps this effect from subscribing to the store's map, which
// every write replaces.
$effect(() => {
  if (!isActive || !prId) return;
  const id = prId;
  untrack(() => void loadConversation(id));
});

// The tab owns CI polling: on while it's on screen and something is pending
// (or a re-run hasn't shown up yet); the store stops on its own once settled.
$effect(() => {
  if (!shouldPollChecks) return;
  const id = prId;
  return untrack(() => watchChecks(id));
});

onMount(() => {
  const onFocus = () => {
    if (isActive) void loadConversation(prId);
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
});

function onKeydown(e: KeyboardEvent): void {
  if (!isActive || !conversation || e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey || isTextEditingKeyTarget(e)) return;
  // The sidebar's file tree binds the same letters (`l` opens a file).
  if (getActivePanel() === "sidebar") return;
  const key = e.key.toLowerCase();
  if (key === "c" && canComment && composer) {
    e.preventDefault();
    composer.focus();
    composer.scrollIntoView({ block: "center", behavior: "smooth" });
  } else if (canEdit && (key === "r" || key === "a" || key === "l")) {
    e.preventDefault();
    if (key === "r") reviewersOpen = true;
    if (key === "a") assigneesOpen = true;
    if (key === "l") labelsOpen = true;
  }
}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="conversation">
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
					verb="opened"
					createdAt={conversation.createdAt}
					body={conversation.body}
					url={conversation.url}
					emptyText="No description provided."
					onsave={canEdit ? (body) => editBody(prId, body) : undefined}
				/>
			</div>


			<div class="slot-timeline">
				<Timeline
					{conversation}
					canEdit={canComment}
					onEditComment={(id, body) => editComment(prId, id, body)}
					onDeleteComment={(id) => deleteComment(prId, id)}
				/>
			</div>

			<!-- Where CI stands now, after the history that led here: GitHub's merge
			     box sits in the same place. Each commit above carries its own CI
			     state in the timeline. -->
			<div class="slot-checks">
				<CiChecks
					rollup={conversation.ci}
					denied={conversation.ciAccess === 'denied'}
					prUrl={conversation.url}
					details={entry.checkDetails}
					{canRerun}
					onExpand={(id) => void loadCheckDetails(prId, id)}
					onRerunRuns={(runIds) => rerunFailedRuns(prId, runIds)}
					onRerunJob={(jobId) => rerunJob(prId, jobId)}
				/>
			</div>

			{#if canComment && conversation.state === 'open'}
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

	<aside class="conversation-side" aria-label="Pull request details">
		{#if conversation}
			<ConversationSidebar
				{prId}
				{conversation}
				{canEdit}
				onReviewers={(added, removed) => void changeReviewers(prId, added, removed)}
				onAssignees={(added, removed) => void changeAssignees(prId, added, removed)}
				onLabels={(added, removed) => void changeLabels(prId, added, removed)}
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
	/* The main-area-anchored 6-col grid every review tab shares (see
	   GuidedWalkthrough.svelte's `.walkthrough-content` for the col_1
	   derivation): the timeline takes col 3, the sidebar the 380px
	   annotation rail in col 5. Col 3 is a FIXED 820px, not minmax, because
	   the Your review panels set `container-type: inline-size` and would
	   report a 0 max-content, collapsing a content-sized track. */
	.conversation {
		display: grid;
		grid-template-columns:
			max(24px, min(calc(50% - 458px), calc(100% - 1312px)))
			48px
			820px
			40px
			380px
			minmax(24px, 1fr);
		align-items: start;
		/* Clears the floating review action bar. */
		padding: 16px 0 100px;
		background: var(--color-bg-primary);
	}

	.conversation-main {
		grid-column: 3;
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
	}

	.conversation-side {
		grid-column: 5;
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
	@container (max-width: 1335px) {
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
		.slot-timeline,
		.slot-composer,
		.slot-review,
		.conversation-error,
		.conversation-skeleton {
			order: 2;
		}
	}
</style>
