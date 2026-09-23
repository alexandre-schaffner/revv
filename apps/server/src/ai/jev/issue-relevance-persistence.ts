import type { IssueSeverity, WalkthroughIssue } from "@revv/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { commentThreads } from "../../db/schema/comment-threads";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import type { IssueCandidate, IssueJudgment, JudgmentSink } from "./contracts";
import { markRetracted } from "./pending";

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
    updated = {
      id: row.id,
      severity,
      title: row.title,
      description: row.description,
      blockIds: parseBlockIds(row.blockIds),
      advisoryScore: judgment.score,
      lowSignal: judgment.lowSignal,
      ...(row.filePath !== null ? { filePath: row.filePath } : {}),
      ...(row.startLine !== null ? { startLine: row.startLine } : {}),
      ...(row.endLine !== null ? { endLine: row.endLine } : {}),
    };
  });

  if (retractedIssue) {
    markRetracted(walkthroughId, issueId);
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

function parseBlockIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}
