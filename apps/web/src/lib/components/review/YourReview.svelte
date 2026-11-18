<script lang="ts">
import {
  isIssueResolved,
  isThreadResolved,
  type ReviewAction,
  type WalkthroughIssue,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { submitChatMessage } from "$lib/chat/turn.svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import ReviewActionBar from "$lib/components/review/chrome/ReviewActionBar.svelte";
import { viewerIsAuthor } from "$lib/prs/viewer";
import { buildAddressIssuesPrompt } from "$lib/review/address-issues-prompt";
import { IssueSelection } from "$lib/review/issue-selection.svelte";
import { submitReview } from "$lib/review/submit-review";
import { postableThreads } from "$lib/review/threads";
import { getActiveTab } from "$lib/stores/pr-view-state.svelte";
import { deleteThread, getThreads } from "$lib/stores/review.svelte";
import { setRightPanelOpen } from "$lib/stores/sidebar.svelte";
import { getIssueSignal } from "$lib/walkthrough/store.svelte";
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
	<IssuesPanel {prId} {issues} {filteredIssues} {selection} />

	<CommentsPanel
		{prId}
		threads={unresolvedThreads}
		onDiscard={(threadId) => void deleteThread(threadId)}
	/>
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
</style>
