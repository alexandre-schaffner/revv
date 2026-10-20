<script lang="ts">
import { isPublishableDraftComment } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { sendChatMessage } from "$lib/stores/chat.svelte";
import { loadConversation } from "$lib/stores/conversation.svelte";
import {
  deleteThread,
  getReviewFiles,
  getThreadMessages,
  getThreads,
  jumpToDiffLine,
  jumpToWalkthroughBlock,
  loadSession,
} from "$lib/stores/review.svelte";
import {
  resetReviewBar,
  setReviewBarHandlers,
  setReviewBarState,
} from "$lib/stores/reviewBar.svelte";
import { getSettings } from "$lib/stores/settings.svelte";
import { setRightPanelOpen } from "$lib/stores/sidebar.svelte";
import { getBlocks, getIssues, markIssuesAsSubmitted } from "$lib/stores/walkthrough.svelte";
import { buildAddressIssuesPrompt } from "$lib/utils/prompts";
import { partitionBySignal, shouldHideLowSignal } from "$lib/utils/walkthrough-issues";
import ApproveWithIssuesDialog from "./ApproveWithIssuesDialog.svelte";
import CommentsPanel from "./comments-panel/CommentsPanel.svelte";
import IssuesPanel from "./issues-panel/IssuesPanel.svelte";

interface Props {
  prId: string;
}
let { prId }: Props = $props();

type Action = "approve" | "request_changes" | "comment";

// Filtered once here rather than at each of the four consumers below, so a
// low-signal issue the reader never saw can't be posted via select-all.
const issueSignal = $derived(
  partitionBySignal(getIssues(), { hideLowSignal: shouldHideLowSignal(getSettings()) }),
);
const issues = $derived(issueSignal.shown);
const filteredIssues = $derived(issueSignal.filtered);
const unresolvedIssues = $derived(
  issues.filter(
    (issue) => issue.resolutionStatus !== "addressed" && issue.resolutionStatus !== "wont_fix",
  ),
);
const threads = $derived(getThreads());
const unresolvedThreads = $derived(
  threads.filter((t) => t.status !== "resolved" && t.status !== "wont_fix"),
);
const blocks = $derived(getBlocks());

// File paths currently part of the PR diff (new path + old path for renames).
// A pending comment whose file isn't here is stale: its line no longer exists
// in the diff, so including it would make GitHub 422 the whole review.
const currentFilePaths = $derived(
  new Set(getReviewFiles().flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]))),
);

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
let submitting = $state<Action | null>(null);
let submitError = $state<string | null>(null);
let submitSuccess = $state<{ action: Action; htmlUrl: string } | null>(null);
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

// Number of unresolved threads that carry at least one unsynced reviewer
// message — i.e. line comments that would actually be pushed to GitHub.
// Mirrors the filtering in buildComments() so the Comment button's enabled
// state matches what gets sent.
const pendingCommentCount = $derived(
  unresolvedThreads.filter((t) => getThreadMessages(t.id).some(isPublishableDraftComment)).length,
);
// A plain COMMENT review can go up with selected issues OR pending comments.
const canComment = $derived(selectedCount > 0 || pendingCommentCount > 0);

const approveBlockerSummary = $derived.by(() => {
  const parts: string[] = [];
  if (unresolvedIssues.length > 0) {
    parts.push(
      `${unresolvedIssues.length} walkthrough issue${unresolvedIssues.length === 1 ? "" : "s"}`,
    );
  }
  if (unresolvedThreads.length > 0) {
    parts.push(
      `${unresolvedThreads.length} unresolved comment${unresolvedThreads.length === 1 ? "" : "s"}`,
    );
  }
  return parts.join(" and ");
});

function severityTag(s: "info" | "warning" | "critical"): string {
  // Plain-text tag used inside the markdown body posted to GitHub.
  // Keeps the comment icon-free per project UI conventions.
  return s === "critical" ? "`[CRITICAL]`" : s === "warning" ? "`[WARNING]`" : "`[INFO]`";
}

function buildBody(): string {
  const parts: string[] = [];
  if (selectedIssues.length > 0) {
    parts.push("### Walkthrough issues");
    for (const issue of selectedIssues) {
      const loc =
        issue.filePath && issue.startLine != null
          ? ` (\`${issue.filePath}:${issue.startLine}${issue.endLine != null && issue.endLine !== issue.startLine ? `–${issue.endLine}` : ""}\`)`
          : issue.filePath
            ? ` (\`${issue.filePath}\`)`
            : "";
      parts.push(
        `- ${severityTag(issue.severity)} **${issue.title}**${loc}\n  ${issue.description}`,
      );
    }
  }
  return parts.join("\n\n");
}

function buildComments(): Array<{
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  threadId: string;
}> {
  const out: Array<{
    path: string;
    body: string;
    line: number;
    side: "LEFT" | "RIGHT";
    startLine?: number;
    threadId: string;
  }> = [];

  // Collect IDs of all unresolved threads
  for (const thread of unresolvedThreads) {
    // Threads already on GitHub take the reply push path (see submit()), not
    // the new-review-comment path — including them here would re-post the
    // thread as a fresh comment on every submit.
    if (thread.externalCommentId != null) continue;
    // Skip pending comments whose file is no longer in the diff — sending one
    // would make GitHub reject the entire review (422). It stays a local draft
    // the user can remove with the Discard button. Skip the check when the
    // diff hasn't loaded (empty set) so valid comments are never dropped.
    if (currentFilePaths.size > 0 && !currentFilePaths.has(thread.filePath)) continue;
    const messages = getThreadMessages(thread.id).filter(isPublishableDraftComment);
    const body = messages
      .map((m) => m.body)
      .filter((b) => b.trim().length > 0)
      .join("\n\n");
    if (!body) continue;
    const comment: {
      path: string;
      body: string;
      line: number;
      side: "LEFT" | "RIGHT";
      startLine?: number;
      threadId: string;
    } = {
      path: thread.filePath,
      body,
      line: thread.endLine,
      side: thread.diffSide === "old" ? "LEFT" : "RIGHT",
      threadId: thread.id,
    };
    if (thread.startLine !== thread.endLine) {
      comment.startLine = thread.startLine;
    }
    out.push(comment);
  }
  return out;
}

async function submit(action: Action): Promise<void> {
  if (submitting) return;
  submitting = action;
  submitError = null;
  submitSuccess = null;

  try {
    const body = buildBody();
    const comments = buildComments();
    const issueIdsForSubmit = selectedIssues.map((issue) => issue.id);
    const { data, error } = await api.api
      .reviews({ id: prId })
      ["github-submit"].post({ action, body, comments, issueIds: issueIdsForSubmit });
    if (error) {
      const msg =
        typeof error.value === "object" && error.value !== null && "error" in error.value
          ? String((error.value as { error: unknown }).error)
          : `HTTP ${error.status}`;
      throw new Error(msg);
    }

    // Push unsynced replies: messages in synced threads that have no externalId
    const syncedThreads = threads.filter((t) => t.externalCommentId != null);
    const pushTasks = syncedThreads.flatMap((thread) =>
      getThreadMessages(thread.id)
        .filter((msg) => msg.externalId == null && msg.authorRole === "reviewer")
        .map((msg) =>
          api.api.threads({ id: thread.id }).messages({ messageId: msg.id }).push.post(),
        ),
    );
    await Promise.allSettled(pushTasks);

    // Trigger sync-threads to pull back GitHub comment IDs
    await api.api.prs({ id: prId })["sync-threads"].post();

    // Reload session so externalCommentId / externalId fields are refreshed
    // locally (mode is derived inside loadSession from the PR's review
    // perspective). `force` bypasses the 60s refetch short-circuit — without
    // it the just-pushed comments keep their null externalId locally and a
    // second submit would re-post them as duplicates.
    await loadSession(prId, undefined, true);
    // The review changed the viewer's verdict, which the action bar reads off
    // the conversation: an approval swaps Approve for Merge. Re-read it before
    // `submitting` clears, so Approve never re-arms in between.
    await loadConversation(prId, { force: true });

    const payload = data as {
      htmlUrl?: string;
      issuesSubmittedAt?: string | null;
      submittedIssueIds?: string[];
      skippedComments?: Array<{ threadId: string; path: string; line: number; reason: string }>;
    } | null;
    submitSuccess = { action, htmlUrl: payload?.htmlUrl ?? "" };
    toast.success(`${actionLabel(action)} on GitHub`);
    // Comments GitHub can't take (their lines aren't in the diff) are left out
    // of the review rather than letting one of them 422 the whole submission.
    // They stay as local drafts, so say which ones were held back.
    const skipped = payload?.skippedComments ?? [];
    if (skipped.length > 0) {
      const first = skipped[0];
      toast.warning(
        skipped.length === 1 && first
          ? `1 comment not posted — ${first.path}:${first.line}: ${first.reason}`
          : `${skipped.length} comments not posted — their lines are no longer part of the diff`,
      );
    }
    // Mirror the server-side stamp onto the local walkthrough store so
    // the "already posted" treatment renders immediately without
    // waiting for a cache refetch. The server is the source of truth
    // on reload; this is just an optimistic echo.
    const stampedIds = payload?.submittedIssueIds ?? issueIdsForSubmit;
    const stampedAt = payload?.issuesSubmittedAt ?? new Date().toISOString();
    markIssuesAsSubmitted(prId, stampedIds, stampedAt);
    selectedIssueIds = new Set();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to submit review";
    submitError = msg;
    toast.error(msg);
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

function actionLabel(a: Action): string {
  if (a === "approve") return "Approved";
  if (a === "comment") return "Comments posted";
  return "Changes requested";
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

// Register reactive state and handlers into the shared RC actions store so
// AppShell can render the float pill as a direct child of .app-shell.
$effect(() => {
  setReviewBarState({
    submitting,
    selectedCount,
    canComment,
    approveBlockerSummary,
  });
});

$effect(() => {
  setReviewBarHandlers({
    onGenerateChanges: generateChanges,
    // One submit posts everything in a single GitHub review. The review event
    // is decided by content: selecting walkthrough issues means "request
    // changes"; with none it's a plain comment review. Either way the line
    // comments ride along. Read `.size` live so the decision reflects the
    // selection at click time, not when this handler was registered.
    onSubmitReview: () => void submit(selectedCount > 0 ? "request_changes" : "comment"),
    onComment: () => void submit("comment"),
    onApprove: handleApproveClick,
  });
  return resetReviewBar;
});
</script>

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
	oncancel={() => {}}
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
