<script lang="ts">
import {
  isIssueResolved,
  isThreadResolved,
  type ReviewAction,
  type WalkthroughIssue,
} from "@revv/shared";
import BookOpenText from "phosphor-svelte/lib/BookOpenText";
import GitDiff from "phosphor-svelte/lib/GitDiff";
import Tray from "phosphor-svelte/lib/Tray";
import { toast } from "svelte-sonner";
import { submitChatMessage } from "$lib/chat/turn.svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import ReviewActionBar from "$lib/components/review/chrome/ReviewActionBar.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { viewerIsAuthor } from "$lib/prs/viewer";
import { buildAddressIssuesPrompt } from "$lib/review/address-issues-prompt";
import { IssueSelection } from "$lib/review/issue-selection.svelte";
import { submitReview } from "$lib/review/submit-review";
import { postableThreads } from "$lib/review/threads";
import { getActiveTab, setActiveTab } from "$lib/stores/pr-view-state.svelte";
import { deleteThread, getThreads } from "$lib/stores/review.svelte";
import { setRightPanelOpen } from "$lib/stores/sidebar.svelte";
import { getIssueSignal, getPrWalkthroughStatus } from "$lib/walkthrough/store.svelte";
import SubmitReviewDialog from "./SubmitReviewDialog.svelte";
import CommentsPanel from "./spec-panel/CommentsPanel.svelte";
import IssuesPanel from "./spec-panel/IssuesPanel.svelte";

interface Props {
  prId: string;
}
let { prId }: Props = $props();

// Filtered once here rather than at each of the four consumers below, so a
// low-signal issue the reader never saw can't be posted via select-all.
const issueSignal = $derived(getIssueSignal(prId));
const issues = $derived(issueSignal.shown);
const filteredIssues = $derived(issueSignal.filtered);
const unresolvedIssues = $derived(issues.filter((issue) => !isIssueResolved(issue)));
const unresolvedThreads = $derived(getThreads(prId).filter((t) => !isThreadResolved(t.status)));

// What's pending comes from two places, the walkthrough's issues and the
// viewer's diff comments. An empty side says which of the two it's waiting on.
const walkthroughStatus = $derived(getPrWalkthroughStatus(prId));
const hasIssues = $derived(issues.length > 0 || filteredIssues.length > 0);
const hasThreads = $derived(unresolvedThreads.length > 0);
const issuesHint = $derived(
  walkthroughStatus === "complete"
    ? "The walkthrough flagged no issues."
    : walkthroughStatus === "generating"
      ? "The walkthrough is still reading the diff. Issues it flags land here."
      : "No walkthrough yet. Issues it flags land here.",
);

const selection = new IssueSelection(() => issues);
let submitting = $state<ReviewAction | null>(null);
let dialogOpen = $state(false);
let dialogAction = $state<ReviewAction>("comment");

const selectedCount = $derived(selection.selected.length);
// With no issue ticked, only the reviewer's own drafts are left to post.
const canComment = $derived(selectedCount > 0 || postableThreads(prId, new Set()).length > 0);

/**
 * Every review goes through the dialog, which owns the choice of event. It
 * opens on the likeliest one: ticked issues ask for changes, drafts make a
 * comment, and with nothing to post the review can only be an approval.
 */
function openDialog(): void {
  if (submitting) return;
  dialogAction = selectedCount > 0 ? "request_changes" : canComment ? "comment" : "approve";
  dialogOpen = true;
}

async function submit(
  action: ReviewAction,
  issues: readonly WalkthroughIssue[],
  threadIds: readonly string[],
): Promise<boolean> {
  if (submitting) return false;
  submitting = action;
  try {
    const ok = await submitReview(prId, action, issues, threadIds);
    if (ok) selection.clear();
    return ok;
  } finally {
    submitting = null;
  }
}

/**
 * The chat agent addresses the selected issues as commits on its worktree's
 * working branch, after any turn already running; the user then picks which
 * to keep from the chat panel's proposed-changes strip.
 */
function generateChanges(): void {
  if (selectedCount === 0) {
    toast.error("Select at least one issue to address.");
    return;
  }
  setRightPanelOpen(true);
  submitChatMessage(prId, buildAddressIssuesPrompt(selection.selected), []);
}

useShellChrome(() => ({
  actions: getActiveTab() === "conversation" ? reviewActions : undefined,
}));
</script>

{#snippet reviewActions()}
	<!-- One "Submit review" opens the dialog, where the reviewer picks the
	     event and sees everything the review posts. -->
	<ReviewActionBar
		{prId}
		{submitting}
		{selectedCount}
		{canComment}
		onGenerateChanges={generateChanges}
		onSubmitReview={openDialog}
	/>
{/snippet}

<div class="your-review">
	{#if !hasIssues && !hasThreads}
		<div class="review-empty">
			<span class="review-empty-mark" aria-hidden="true"><Tray size={16} /></span>
			<div class="review-empty-text">
				<p class="review-empty-title">
					{walkthroughStatus === 'complete' ? 'Nothing to post' : 'Nothing to post yet'}
				</p>
				<p class="review-empty-body">
					{#if walkthroughStatus === 'complete'}
						The walkthrough flagged no issues. Comments you leave on the diff wait here until
						you submit your review.
					{:else if walkthroughStatus === 'generating'}
						The walkthrough is still reading the diff. Issues it flags and comments you leave
						on the diff collect here, then go to GitHub as one review.
					{:else}
						Issues the walkthrough flags and comments you leave on the diff collect here, then
						go to GitHub as one review.
					{/if}
				</p>
				<div class="review-empty-actions">
					{#if walkthroughStatus !== 'complete'}
						<Button variant="outline" size="sm" onclick={() => setActiveTab('walkthrough')}>
							<BookOpenText aria-hidden="true" />Open walkthrough
						</Button>
					{/if}
					<Button variant="outline" size="sm" onclick={() => setActiveTab('diff')}>
						<GitDiff aria-hidden="true" />Open diff
					</Button>
				</div>
			</div>
		</div>
	{:else}
		{#if hasIssues}
			<IssuesPanel {prId} {issues} {filteredIssues} {selection} />
		{:else}
			<p class="review-hint">
				{issuesHint}
				{#if walkthroughStatus !== 'complete'}
					<button type="button" onclick={() => setActiveTab('walkthrough')}>Open walkthrough</button>
				{/if}
			</p>
		{/if}

		{#if hasThreads}
			<CommentsPanel
				{prId}
				threads={unresolvedThreads}
				onDiscard={(threadId) => void deleteThread(threadId)}
			/>
		{:else}
			<p class="review-hint">
				No pending comments. Ones you leave on the diff wait here until you submit.
				<button type="button" onclick={() => setActiveTab('diff')}>Open diff</button>
			</p>
		{/if}
	{/if}
</div>

<SubmitReviewDialog
	bind:open={dialogOpen}
	{prId}
	initialAction={dialogAction}
	commentOnly={viewerIsAuthor(prId)}
	issues={selection.selected}
	unresolvedIssueCount={unresolvedIssues.length}
	unresolvedThreadCount={unresolvedThreads.length}
	submitting={submitting !== null}
	onsubmit={submit}
/>

<style>
	/* The pending review: walkthrough issues to post and line comments not yet
	   on GitHub. Both panels set `container-type: inline-size`, so they take
	   their width from this column rather than from their content. */
	.your-review {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.review-empty {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.review-empty-mark {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-card);
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.review-empty-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.review-empty-title {
		display: flex;
		align-items: center;
		min-height: 32px;
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--color-text-primary);
	}

	.review-empty-body {
		max-width: 60ch;
		margin: 0;
		font-size: var(--text-sm);
		line-height: 1.5;
		text-wrap: pretty;
		color: var(--color-text-secondary);
	}

	.review-empty-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}

	.review-hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.review-hint button {
		margin-left: 4px;
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		color: var(--color-text-primary);
		text-decoration: underline;
		text-decoration-color: var(--color-border);
		text-underline-offset: 3px;
		cursor: pointer;
	}

	.review-hint button:hover {
		text-decoration-color: currentColor;
	}
</style>
