<script lang="ts">
import { isIssueResolved, isPublishableDraftComment, isThreadResolved } from "@revv/shared";
import { toast } from "svelte-sonner";
import { sendChatMessage } from "$lib/chat/turn.svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import ReviewActionBar from "$lib/components/review/chrome/ReviewActionBar.svelte";
import { type ReviewAction, submitReview } from "$lib/review/submit-review";
import { getActiveTab } from "$lib/stores/pr-view-state.svelte";
import { deleteThread, getThreadMessages, getThreads } from "$lib/stores/review.svelte";
import { jumpToDiffLine, jumpToWalkthroughBlock } from "$lib/stores/review-nav.svelte";
import { setRightPanelOpen } from "$lib/stores/sidebar.svelte";
import { outstandingItemsPhrase } from "$lib/walkthrough/issues";
import { getBlocks, getIssueSignal } from "$lib/walkthrough/store.svelte";
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
const threads = $derived(getThreads());
const unresolvedThreads = $derived(threads.filter((t) => !isThreadResolved(t.status)));
const blocks = $derived(getBlocks(prId));

let selectedIssueIds = $state<Set<string>>(new Set());
// Derived from the walkthrough store — each issue carries its own
// `submittedAt` once persisted on the server. Deriving here (instead of
// caching a module-level Map) means the "already posted" treatment
// survives reloads, PR-switches, and app restarts: on next mount the
// cached walkthrough fetch hydrates `issues` with the timestamp intact.
const submittedIssueIds = $derived(
  new Set(issues.filter((i) => i.submittedAt != null).map((i) => i.id)),
);
const selectableIssueIds = $derived(
  new Set(
    unresolvedIssues.filter((issue) => !submittedIssueIds.has(issue.id)).map((issue) => issue.id),
  ),
);
const selectedIssues = $derived(unresolvedIssues.filter((issue) => selectedIssueIds.has(issue.id)));

// External-agent edits can resolve an issue while this view is mounted.
// Normalize the selection immediately so no later action can submit a stale id.
$effect(() => {
  const next = new Set([...selectedIssueIds].filter((id) => selectableIssueIds.has(id)));
  if (next.size !== selectedIssueIds.size) selectedIssueIds = next;
});
let submitting = $state<ReviewAction | null>(null);
let approveDialogOpen = $state(false);

/**
 * Approve click handler. When the walkthrough flagged any issues OR there are
 * unresolved comment threads, we surface a confirmation dialog so the reviewer
 * has to explicitly acknowledge they're approving despite outstanding concerns.
 * With a clean slate we submit directly.
 */
function handleApproveClick(): void {
  if (submitting) return;
  if (unresolvedIssues.length > 0 || unresolvedThreads.length > 0) {
    approveDialogOpen = true;
    return;
  }
  void submit("approve");
}

const selectedCount = $derived(selectedIssues.length);

// Unresolved threads with a message `submitReview` would post, so the
// Comment button's enabled state matches what gets sent.
const pendingCommentCount = $derived(
  unresolvedThreads.filter((t) => getThreadMessages(t.id).some(isPublishableDraftComment)).length,
);
// A plain COMMENT review can go up with selected issues OR pending comments.
const canComment = $derived(selectedCount > 0 || pendingCommentCount > 0);

const approveBlockerSummary = $derived(
  outstandingItemsPhrase(unresolvedIssues.length, unresolvedThreads.length),
);

async function submit(action: ReviewAction): Promise<void> {
  if (submitting) return;
  submitting = action;
  try {
    if (await submitReview(prId, action, selectedIssues)) selectedIssueIds = new Set();
  } finally {
    submitting = null;
  }
}

/**
 * Hand the selected walkthrough issues to the right-pane chat agent and
 * ask it to address them as commits on the chat worktree's working
 * branch. The user can then inspect the proposed-changes strip in the
 * chat panel and choose which commits to keep.
 */
function generateChanges(): void {
  const selected = selectedIssues;
  if (selected.length === 0) {
    toast.error("Select at least one issue to address.");
    return;
  }
  const prompt = buildAddressIssuesPrompt(selected);
  setRightPanelOpen(true);
  sendChatMessage({ prId, message: prompt });
}

const allIssuesSelected = $derived(
  selectableIssueIds.size > 0 && [...selectableIssueIds].every((id) => selectedIssueIds.has(id)),
);

function toggleIssue(id: string) {
  if (!selectableIssueIds.has(id)) return;
  const next = new Set(selectedIssueIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIssueIds = next;
}

function toggleAllIssues() {
  if (allIssuesSelected) {
    selectedIssueIds = new Set();
  } else {
    selectedIssueIds = new Set(selectableIssueIds);
  }
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
	<IssuesPanel
		{issues}
		{filteredIssues}
		selectedIds={selectedIssueIds}
		submittedIds={submittedIssueIds}
		onToggleSelect={toggleIssue}
		onToggleSelectAll={toggleAllIssues}
		onFileClick={jumpToDiffLine}
		{blocks}
		onBlockJump={jumpToWalkthroughBlock}
	/>

	<CommentsPanel
		threads={unresolvedThreads}
		{getThreadMessages}
		onJump={jumpToDiffLine}
		onDiscard={(threadId) => void deleteThread(threadId)}
	/>
</div>

<ApproveWithIssuesDialog
	bind:open={approveDialogOpen}
	issues={unresolvedIssues}
	pendingThreads={unresolvedThreads}
	{getThreadMessages}
	onfileclick={(path, line) => jumpToDiffLine(path, line)}
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
