// Posting "Your review" to GitHub: one review carrying the chosen walkthrough
// issues and every pending line comment, then the replies on threads already
// on GitHub, then bringing the local session back in line with what GitHub
// now holds.

import {
  type IssueSeverity,
  isPublishableDraftComment,
  isThreadResolved,
  type WalkthroughIssue,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { acceptWriteResult } from "$lib/stores/conversation.svelte";
import { getReviewFiles } from "$lib/stores/diff-files.svelte";
import { getThreadMessages, getThreads, loadSession } from "$lib/stores/review.svelte";
import { markIssuesAsSubmitted } from "$lib/stores/walkthrough.svelte";

export type ReviewAction = "approve" | "request_changes" | "comment";

interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  threadId: string;
}

// Plain-text tags: the posted markdown stays icon-free.
function severityTag(s: IssueSeverity): string {
  return s === "critical" ? "`[CRITICAL]`" : s === "warning" ? "`[WARNING]`" : "`[INFO]`";
}

function reviewBody(issues: readonly WalkthroughIssue[]): string {
  if (issues.length === 0) return "";
  const lines = issues.map((issue) => {
    const range =
      issue.endLine != null && issue.endLine !== issue.startLine ? `–${issue.endLine}` : "";
    const loc =
      issue.filePath && issue.startLine != null
        ? ` (\`${issue.filePath}:${issue.startLine}${range}\`)`
        : issue.filePath
          ? ` (\`${issue.filePath}\`)`
          : "";
    return `- ${severityTag(issue.severity)} **${issue.title}**${loc}\n  ${issue.description}`;
  });
  return ["### Walkthrough issues", ...lines].join("\n\n");
}

/** Unresolved threads not yet on GitHub, as new review comments. */
function reviewComments(): ReviewComment[] {
  // A pending comment whose file left the diff would make GitHub reject the
  // whole review (422); it stays a local draft the user can discard. Before
  // the diff has loaded nothing is known to be stale, so nothing is dropped.
  const diffPaths = new Set(
    getReviewFiles().flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])),
  );
  const out: ReviewComment[] = [];
  for (const thread of getThreads()) {
    if (isThreadResolved(thread.status)) continue;
    // Threads already on GitHub get their replies pushed instead; posting
    // them here would duplicate the thread on every submit.
    if (thread.externalCommentId != null) continue;
    if (diffPaths.size > 0 && !diffPaths.has(thread.filePath)) continue;
    const body = getThreadMessages(thread.id)
      .filter(isPublishableDraftComment)
      .map((m) => m.body)
      .filter((b) => b.trim().length > 0)
      .join("\n\n");
    if (!body) continue;
    out.push({
      path: thread.filePath,
      body,
      line: thread.endLine,
      side: thread.diffSide === "old" ? "LEFT" : "RIGHT",
      threadId: thread.id,
      ...(thread.startLine !== thread.endLine ? { startLine: thread.startLine } : {}),
    });
  }
  return out;
}

/** Push reviewer replies on threads GitHub already has. Resolves how many failed. */
async function pushReplies(): Promise<number> {
  const pushes = getThreads()
    .filter((t) => t.externalCommentId != null)
    .flatMap((thread) =>
      getThreadMessages(thread.id)
        .filter((msg) => msg.externalId == null && msg.authorRole === "reviewer")
        .map((msg) =>
          api.api.threads({ id: thread.id }).messages({ messageId: msg.id }).push.post(),
        ),
    );
  const results = await Promise.allSettled(pushes);
  return results.filter((r) => r.status === "rejected" || r.value.error).length;
}

function actionLabel(action: ReviewAction): string {
  if (action === "approve") return "Approved";
  if (action === "comment") return "Comments posted";
  return "Changes requested";
}

/**
 * Submit the review. Resolves true once GitHub has it; a failure has been
 * reported to the user and resolves false.
 */
export async function submitReview(
  prId: string,
  action: ReviewAction,
  issues: readonly WalkthroughIssue[],
): Promise<boolean> {
  const issueIds = issues.map((issue) => issue.id);
  try {
    const { data, error } = await api.api.reviews({ id: prId })["github-submit"].post({
      action,
      body: reviewBody(issues),
      comments: reviewComments(),
      issueIds,
    });
    if (error) throw new Error(apiErrorMessage(error, "Failed to submit review"));
    const result = data && "htmlUrl" in data ? data : null;
    acceptWriteResult(prId, { conversation: result?.conversation ?? null });

    const failedReplies = await pushReplies();
    // Pull back the GitHub ids of what was just posted, then re-read the
    // session past its freshness window: rows still missing their externalId
    // would be posted again by the next submit.
    await api.api.prs({ id: prId })["sync-threads"].post();
    await loadSession(prId, undefined, true);

    toast.success(`${actionLabel(action)} on GitHub`);
    if (failedReplies > 0) {
      toast.warning(
        failedReplies === 1
          ? "1 reply was not sent to GitHub"
          : `${failedReplies} replies were not sent to GitHub`,
      );
    }
    // Comments on lines no longer in the diff are held back by the server
    // rather than failing the whole review; they stay local drafts.
    const skipped = result?.skippedComments ?? [];
    const first = skipped[0];
    if (first) {
      toast.warning(
        skipped.length === 1
          ? `1 comment not posted — ${first.path}:${first.line}: ${first.reason}`
          : `${skipped.length} comments not posted — their lines are no longer part of the diff`,
      );
    }
    // Echo the server's stamp so "already posted" shows before the next read.
    markIssuesAsSubmitted(
      prId,
      result?.submittedIssueIds ?? issueIds,
      result?.issuesSubmittedAt ?? new Date().toISOString(),
    );
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to submit review");
    return false;
  }
}
