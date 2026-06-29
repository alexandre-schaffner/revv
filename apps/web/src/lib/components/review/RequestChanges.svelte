<script lang="ts">
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import WalkthroughRatingsPanel from "$lib/components/walkthrough/WalkthroughRatingsPanel.svelte";
import { sendChatMessage } from "$lib/stores/chat.svelte";
import { resetRcActions, setRcHandlers, setRcState } from "$lib/stores/rcActions.svelte";
import {
  deleteThread,
  getThreadMessages,
  getThreads,
  jumpToDiffLine,
  jumpToWalkthroughBlock,
  loadSession,
} from "$lib/stores/review.svelte";
import { setRightPanelOpen } from "$lib/stores/sidebar.svelte";
import {
  getBlocks,
  getIssues,
  getRatings,
  markIssuesAsSubmitted,
} from "$lib/stores/walkthrough.svelte";
import { buildAddressIssuesPrompt } from "$lib/utils/prompts";
import ApproveWithIssuesDialog from "./ApproveWithIssuesDialog.svelte";
import CommentsPanel from "./comments-panel/CommentsPanel.svelte";
import IssuesPanel from "./issues-panel/IssuesPanel.svelte";

interface Props {
  prId: string;
}
let { prId }: Props = $props();

type Action = "approve" | "request_changes" | "comment";

const issues = $derived(getIssues());
const threads = $derived(getThreads());
const unresolvedThreads = $derived(
  threads.filter((t) => t.status !== "resolved" && t.status !== "wont_fix"),
);
const ratings = $derived(getRatings());
const blocks = $derived(getBlocks());

let selectedIssueIds = $state<Set<string>>(new Set());
// Derived from the walkthrough store — each issue carries its own
// `submittedAt` once persisted on the server. Deriving here (instead of
// caching a module-level Map) means the "already posted" treatment
// survives reloads, PR-switches, and app restarts: on next mount the
// cached walkthrough fetch hydrates `issues` with the timestamp intact.
const submittedIssueIds = $derived(
  new Set(issues.filter((i) => i.submittedAt != null).map((i) => i.id)),
);
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
  if (issues.length > 0 || unresolvedThreads.length > 0) {
    approveDialogOpen = true;
    return;
  }
  void submit("approve");
}

const selectedCount = $derived(selectedIssueIds.size);

// Number of unresolved threads that carry at least one unsynced reviewer
// message — i.e. line comments that would actually be pushed to GitHub.
// Mirrors the filtering in buildComments() so the Comment button's enabled
// state matches what gets sent.
const pendingCommentCount = $derived(
  unresolvedThreads.filter((t) =>
    getThreadMessages(t.id).some(
      (m) => m.authorRole === "reviewer" && m.externalId == null && m.body.trim().length > 0,
    ),
  ).length,
);
// A plain COMMENT review can go up with selected issues OR pending comments.
const canComment = $derived(selectedCount > 0 || pendingCommentCount > 0);

const approveBlockerSummary = $derived.by(() => {
  const parts: string[] = [];
  if (issues.length > 0) {
    parts.push(`${issues.length} walkthrough issue${issues.length === 1 ? "" : "s"}`);
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
  const selectedIssues = issues.filter((i) => selectedIssueIds.has(i.id));
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
    const messages = getThreadMessages(thread.id).filter(
      (m) => m.authorRole === "reviewer" && m.externalId == null,
    );
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
    const issueIdsForSubmit = Array.from(selectedIssueIds);
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

    const payload = data as {
      htmlUrl?: string;
      issuesSubmittedAt?: string | null;
      submittedIssueIds?: string[];
    } | null;
    submitSuccess = { action, htmlUrl: payload?.htmlUrl ?? "" };
    toast.success(`${actionLabel(action)} on GitHub`);
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
  const selected = issues.filter((i) => selectedIssueIds.has(i.id));
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
  issues.length > 0 && issues.every((i) => selectedIssueIds.has(i.id)),
);

function toggleIssue(id: string) {
  if (submittedIssueIds.has(id)) return;
  const next = new Set(selectedIssueIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIssueIds = next;
}

function toggleAllIssues() {
  if (allIssuesSelected) {
    selectedIssueIds = new Set();
  } else {
    selectedIssueIds = new Set(issues.filter((i) => !submittedIssueIds.has(i.id)).map((i) => i.id));
  }
}

// Register reactive state and handlers into the shared RC actions store so
// AppShell can render the float pill as a direct child of .app-shell.
$effect(() => {
  setRcState({
    submitting,
    selectedCount,
    canComment,
    approveBlockerSummary,
  });
});

$effect(() => {
  setRcHandlers({
    onGenerateChanges: generateChanges,
    // One submit posts everything in a single GitHub review. The review event
    // is decided by content: selecting walkthrough issues means "request
    // changes"; with none it's a plain comment review. Either way the line
    // comments ride along. Read `.size` live so the decision reflects the
    // selection at click time, not when this handler was registered.
    onSubmitReview: () => void submit(selectedIssueIds.size > 0 ? "request_changes" : "comment"),
    onComment: () => void submit("comment"),
    onApprove: handleApproveClick,
  });
  return resetRcActions;
});
</script>

<div class="request-changes">
	<div class="rc-sections">
		<IssuesPanel
			{issues}
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

		{#if ratings.length > 0}
			<div class="rc-scorecard">
				<WalkthroughRatingsPanel {ratings} {blocks} onJump={jumpToWalkthroughBlock} />
			</div>
		{/if}
	</div>
</div>

<ApproveWithIssuesDialog
	bind:open={approveDialogOpen}
	{issues}
	pendingThreads={unresolvedThreads}
	{getThreadMessages}
	onfileclick={(path, line) => jumpToDiffLine(path, line)}
	onconfirm={() => void submit('approve')}
	oncancel={() => {}}
/>

<style>
	.request-changes {
		display: flex;
		flex-direction: column;
		background: var(--color-bg-primary);
	}

	/* Both sections use the SAME main-area-anchored 6-col grid as
	   `.walkthrough-content` (see GuidedWalkthrough.svelte for the col_1
	   derivation — it re-centres the content column on every sidebar/right-panel
	   toggle and aligns with the `.page-title-section--narrow` header above).
	   Column layout must stay byte-identical to the walkthrough grids so the
	   title, the Request Changes panels, and the walkthrough content all
	   land in the same horizontal band.

	   One deliberate deviation: col 3 is a FIXED 820px (not
	   `minmax(0, 820px)`) because every direct child in col 3 — IssuesPanel,
	   CommentsPanel, WalkthroughRatingsPanel — sets `container-type:
	   inline-size` for its own container queries. Inline-size containment
	   means the element's intrinsic size isn't derived from its descendants,
	   so when the grid algorithm asks those panels for their max-content to
	   size a `minmax(0, 820px)` track, they all report ~0 and the track
	   collapses — leaving the panels squished to min-content inside a 0-wide
	   column while the two flex tracks absorb the leftover space. Fixing
	   col 3 at 820px sidesteps the content-sized track entirely. The
	   narrow-viewport fallback below collapses the whole grid anyway, so we
	   never overflow at small widths. */
	.rc-sections {
		display: grid;
		grid-template-columns:
			max(24px, min(calc(50% - 458px), calc(100% - 1312px)))
			48px
			820px
			40px
			380px
			minmax(24px, 1fr);
		/* Extra bottom padding keeps the last panel clear of the floating
		   action bar (approx 36px button + 40px bottom offset + 12px gap). */
		padding: 16px 0 100px;
		row-gap: 20px;
	}

	/* Inner sections land in col 3 (820 content column). */
	.rc-sections > :global(*) {
		grid-column: 3;
	}

	/* Narrow-viewport fallback — matches the GuidedWalkthrough + page-title
	   breakpoint so all three containers collapse at the same main-area
	   width. `@container` (not `@media`) is load-bearing: we're gating on
	   `.review-content`'s inline-size, which shrinks when the sidebar
	   expands. An `@media` rule would keep the grid active at wide viewports
	   even when the main-area has dropped below the 1336 geometric minimum
	   (wide viewport + wide sidebar), causing overflow. */
	@container (max-width: 1335px) {
		.rc-sections {
			display: block;
			max-width: 860px;
			padding-left: 32px;
			padding-right: 32px;
			margin-inline: auto;
			box-sizing: border-box;
			width: 100%;
			padding-top: 16px;
			padding-bottom: 100px;
			display: flex;
			flex-direction: column;
			gap: 20px;
		}

		.rc-sections > :global(*) {
			grid-column: auto;
		}
	}

	/* .rc-scorecard is a plain wrapper — no section header here. The scorecard
	   renders its own internal summary bar, so a wrapping section header would
	   be redundant. Separation from siblings is handled by the 20px gap on
	   .rc-sections. */
</style>
