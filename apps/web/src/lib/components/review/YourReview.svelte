<script lang="ts">
import { isIssueResolved, isThreadResolved } from "@revv/shared";
import { toast } from "svelte-sonner";
import { submitChatMessage } from "$lib/chat/turn.svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import ReviewActionBar from "$lib/components/review/chrome/ReviewActionBar.svelte";
import { IssueSelection } from "$lib/review/issue-selection.svelte";
import { type ReviewAction, submitReview } from "$lib/review/submit-review";
import { postableThreadCount } from "$lib/review/threads";
import { getActiveTab } from "$lib/stores/pr-view-state.svelte";
import { deleteThread, getThreads } from "$lib/stores/review.svelte";
import { setRightPanelOpen } from "$lib/stores/sidebar.svelte";
import { outstandingItemsPhrase } from "$lib/walkthrough/issues";
import { getIssueSignal } from "$lib/walkthrough/store.svelte";
import ApproveWithIssuesDialog from "./ApproveWithIssuesDialog.svelte";
import { buildAddressIssuesPrompt } from "./address-issues-prompt";
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
let approveDialogOpen = $state(false);

/**
 * Outstanding issues or unresolved threads make the reviewer confirm that
 * they're approving despite them; a clean slate submits directly.
 */
function handleApproveClick(): void {
  if (submitting) return;
  if (unresolvedIssues.length > 0 || unresolvedThreads.length > 0) {
    approveDialogOpen = true;
    return;
  }
  void submit("approve");
}

const selectedCount = $derived(selection.selected.length);
const canComment = $derived(selectedCount > 0 || postableThreadCount(prId) > 0);

const approveBlockerSummary = $derived(
  outstandingItemsPhrase(unresolvedIssues.length, unresolvedThreads.length),
);

async function submit(action: ReviewAction): Promise<void> {
  if (submitting) return;
  submitting = action;
  try {
    if (await submitReview(prId, action, selection.selected)) selection.clear();
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
	<!-- One submit posts everything in a single GitHub review. The review event
	     is decided by content: selecting walkthrough issues means "request
	     changes"; with none it's a plain comment review. Either way the line
	     comments ride along. -->
	<ReviewActionBar
		{prId}
		{submitting}
		{selectedCount}
		{canComment}
		{approveBlockerSummary}
		onGenerateChanges={generateChanges}
		onSubmitReview={() => void submit(selectedCount > 0 ? 'request_changes' : 'comment')}
		onComment={() => void submit('comment')}
		onApprove={handleApproveClick}
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

<ApproveWithIssuesDialog
	bind:open={approveDialogOpen}
	{prId}
	issues={unresolvedIssues}
	pendingThreads={unresolvedThreads}
	onconfirm={() => void submit('approve')}
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
