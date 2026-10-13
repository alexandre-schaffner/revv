<script lang="ts">
import type {
  ConversationActor,
  PrConversation,
  PrLabel,
  ReviewerEntry,
  TimelineComment,
} from "@revv/shared";
import ArrowClockwise from "phosphor-svelte/lib/ArrowClockwise";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import { onMount, untrack } from "svelte";
import YourReview from "$lib/components/review/YourReview.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import {
  applyConversationWrite,
  getConversation,
  loadCheckDetails,
  loadConversation,
  watchChecks,
} from "$lib/stores/conversation.svelte";
import { getSelectedPr } from "$lib/stores/prs.svelte";
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
const hasPendingChecks = $derived(
  conversation?.ci?.checks.some((c) => c.bucket === "pending") ?? false,
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

// Poll CI only while something is pending and the tab is on screen.
$effect(() => {
  if (!isActive || !hasPendingChecks) return;
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
  if (!isActive || !conversation) return;
  if (e.metaKey || e.ctrlKey || e.altKey || isTextEditingKeyTarget(e)) return;
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

// ── Writes, each with its optimistic reading ────────────────────────────────

function viewer(c: PrConversation): ConversationActor {
  return (
    c.participants.find((p) => p.login === c.viewerLogin) ?? {
      login: c.viewerLogin,
      name: null,
      avatarContent: null,
      kind: "user",
    }
  );
}

const bareActor = (login: string): ConversationActor => ({
  login,
  name: null,
  avatarContent: null,
  kind: "user",
});

async function postComment(body: string): Promise<boolean> {
  return applyConversationWrite(prId, { kind: "post_comment", body }, (c) => {
    const now = new Date().toISOString();
    const pending: TimelineComment = {
      kind: "comment",
      id: `pending-${now}`,
      createdAt: now,
      databaseId: 0,
      author: viewer(c),
      body,
      edited: false,
      url: "",
      viewerCanUpdate: false,
      viewerCanDelete: false,
    };
    return { ...c, timeline: [...c.timeline, pending] };
  });
}

function editComment(commentId: number, body: string): Promise<boolean> {
  return applyConversationWrite(prId, { kind: "edit_comment", commentId, body }, (c) => ({
    ...c,
    timeline: c.timeline.map((t) =>
      t.kind === "comment" && t.databaseId === commentId ? { ...t, body, edited: true } : t,
    ),
  }));
}

function deleteComment(commentId: number): Promise<boolean> {
  return applyConversationWrite(prId, { kind: "delete_comment", commentId }, (c) => ({
    ...c,
    timeline: c.timeline.filter((t) => !(t.kind === "comment" && t.databaseId === commentId)),
  }));
}

function editBody(body: string): Promise<boolean> {
  return applyConversationWrite(prId, { kind: "edit_body", body }, (c) => ({ ...c, body }));
}

async function changeReviewers(change: {
  addUsers: string[];
  addTeams: string[];
  removeUsers: string[];
  removeTeams: string[];
}): Promise<void> {
  if (change.addUsers.length > 0 || change.addTeams.length > 0) {
    await applyConversationWrite(
      prId,
      { kind: "request_reviewers", users: change.addUsers, teams: change.addTeams },
      (c) => {
        const reviewers: ReviewerEntry[] = c.reviewers.map((r) =>
          r.kind === "user" && change.addUsers.includes(r.actor.login)
            ? { ...r, requested: true }
            : r,
        );
        const known = new Set(
          reviewers.map((r) => (r.kind === "user" ? r.actor.login : r.combinedSlug)),
        );
        for (const login of change.addUsers) {
          if (known.has(login)) continue;
          reviewers.push({
            kind: "user",
            actor: bareActor(login),
            requested: true,
            asCodeOwner: false,
            verdict: null,
            verdictAt: null,
          });
        }
        for (const slug of change.addTeams) {
          if (known.has(slug)) continue;
          const name = slug.split("/").pop() ?? slug;
          reviewers.push({
            kind: "team",
            combinedSlug: slug,
            slug: name,
            name,
            requested: true,
            asCodeOwner: false,
          });
        }
        return { ...c, reviewers };
      },
    );
  }
  if (change.removeUsers.length > 0 || change.removeTeams.length > 0) {
    await applyConversationWrite(
      prId,
      { kind: "remove_reviewers", users: change.removeUsers, teams: change.removeTeams },
      (c) => ({
        ...c,
        reviewers: c.reviewers.flatMap((r): ReviewerEntry[] => {
          if (r.kind === "team") return change.removeTeams.includes(r.combinedSlug) ? [] : [r];
          if (!change.removeUsers.includes(r.actor.login)) return [r];
          // Someone who already reviewed stays listed with their verdict.
          return r.verdict ? [{ ...r, requested: false }] : [];
        }),
      }),
    );
  }
}

async function changeAssignees(added: string[], removed: string[]): Promise<void> {
  if (added.length > 0) {
    await applyConversationWrite(prId, { kind: "add_assignees", logins: added }, (c) => ({
      ...c,
      assignees: [
        ...c.assignees,
        ...added.map((login) => (login === c.viewerLogin ? viewer(c) : bareActor(login))),
      ],
    }));
  }
  if (removed.length > 0) {
    await applyConversationWrite(prId, { kind: "remove_assignees", logins: removed }, (c) => ({
      ...c,
      assignees: c.assignees.filter((a) => !removed.includes(a.login)),
    }));
  }
}

async function changeLabels(added: PrLabel[], removed: string[]): Promise<void> {
  if (added.length > 0) {
    await applyConversationWrite(
      prId,
      { kind: "add_labels", names: added.map((l) => l.name) },
      (c) => ({ ...c, labels: [...c.labels, ...added] }),
    );
  }
  for (const name of removed) {
    await applyConversationWrite(prId, { kind: "remove_label", name }, (c) => ({
      ...c,
      labels: c.labels.filter((l) => l.name !== name),
    }));
  }
}

async function rerunRuns(runIds: number[]): Promise<void> {
  for (const runId of runIds) {
    await applyConversationWrite(prId, { kind: "rerun_failed", runId });
  }
}

async function rerunJob(jobId: number): Promise<void> {
  await applyConversationWrite(prId, { kind: "rerun_job", jobId });
}

const prAuthorAvatar = $derived(getSelectedPr()?.authorAvatarContent ?? null);
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
					author={{
						...conversation.author,
						avatarContent: conversation.author.avatarContent ?? prAuthorAvatar,
					}}
					verb="opened"
					createdAt={conversation.createdAt}
					body={conversation.body}
					url={conversation.url}
					emptyText="No description provided."
					onsave={canEdit ? editBody : undefined}
				/>
			</div>


			<div class="slot-timeline">
				<Timeline
					{conversation}
					canEdit={canComment}
					onEditComment={editComment}
					onDeleteComment={deleteComment}
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
					onRerunRuns={rerunRuns}
					onRerunJob={rerunJob}
				/>
			</div>

			{#if canComment && conversation.state === 'open'}
				<div class="slot-composer">
					<MarkdownEditor
						placeholder="Add a comment"
						submitLabel="Comment"
						onsubmit={postComment}
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
				onReviewers={(change) => void changeReviewers(change)}
				onAssignees={(added, removed) => void changeAssignees(added, removed)}
				onLabels={(added, removed) => void changeLabels(added, removed)}
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
