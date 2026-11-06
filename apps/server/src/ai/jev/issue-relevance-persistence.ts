import type { IssueSeverity, WalkthroughIssue } from "@revv/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { commentThreads } from "../../db/schema/comment-threads";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { decodeIssue } from "../../services/walkthrough/content";
import type { IssueCandidate, IssueJudgment, JudgmentSink } from "./contracts";

/** Apply one judgment atomically, then broadcast the committed result. */
export function applyJudgment(
  db: Db,
  walkthroughId: string,
  issueId: string,
  candidate: IssueCandidate,
  judgment: IssueJudgment,
  sink: JudgmentSink,
): void {
  const now = new Date().toISOString();
  let retractedThreads: string[] = [];
  let retractedIssue = false;
  let updated: WalkthroughIssue | null = null;

  db.transaction(() => {
    const row = db.select().from(walkthroughIssues).where(eq(walkthroughIssues.id, issueId)).get();
    if (!row || row.walkthroughId !== walkthroughId || row.submittedAt !== null) return;
    if (row.description !== candidate.description || row.severity !== candidate.severity) return;

    if (judgment.discard) {
      retractedThreads = db
        .select({ id: commentThreads.id })
        .from(commentThreads)
        .where(eq(commentThreads.walkthroughIssueId, issueId))
        .all()
        .map((thread) => thread.id);
      db.delete(walkthroughIssues).where(eq(walkthroughIssues.id, issueId)).run();
      retractedIssue = true;
      return;
    }

    const severity = judgment.severity ?? parseSeverity(row.severity);
    db.update(walkthroughIssues)
      .set({ severity, advisoryScore: judgment.score, advisoryScoredAt: now })
      .where(eq(walkthroughIssues.id, issueId))
      .run();
    // The whole issue, decoded from the committed row: the web replaces its
    // copy with this, so a partial payload would drop the resolution fields.
    updated = decodeIssue({
      ...row,
      severity,
      advisoryScore: judgment.score,
      advisoryScoredAt: now,
    });
  });

  if (retractedIssue) {
    sink.markRetracted(issueId);
    for (const threadId of retractedThreads) sink.broadcastThread(threadId);
    sink.emit({ type: "issue:deleted", data: { id: issueId } });
  } else if (updated !== null) {
    sink.emit({ type: "issue", data: updated });
  }
}

function parseSeverity(value: string): IssueSeverity {
  if (value === "info" || value === "warning" || value === "critical") return value;
  return "warning";
}
