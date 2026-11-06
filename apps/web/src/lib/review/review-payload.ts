// What a GitHub review submission carries, built from the review's state.

import {
  type CommentThread,
  type IssueSeverity,
  isPublishableDraftComment,
  isThreadResolved,
  type ThreadMessage,
  type WalkthroughIssue,
} from "@revv/shared";

export interface ReviewComment {
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

export function reviewBody(issues: readonly WalkthroughIssue[]): string {
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

/**
 * Unresolved threads not yet on GitHub, as new review comments. `diffPaths`
 * are the files in the diff (old paths of renames included); empty means the
 * diff isn't loaded, so nothing is known to be stale.
 */
export function reviewComments(
  threads: readonly CommentThread[],
  messagesOf: (threadId: string) => readonly ThreadMessage[],
  diffPaths: ReadonlySet<string>,
): ReviewComment[] {
  const out: ReviewComment[] = [];
  for (const thread of threads) {
    if (isThreadResolved(thread.status)) continue;
    // Threads already on GitHub get their replies pushed instead; posting
    // them here would duplicate the thread on every submit.
    if (thread.externalCommentId != null) continue;
    // A comment whose file left the diff would make GitHub reject the whole
    // review (422); it stays a local draft the user can discard.
    if (diffPaths.size > 0 && !diffPaths.has(thread.filePath)) continue;
    const body = messagesOf(thread.id)
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
