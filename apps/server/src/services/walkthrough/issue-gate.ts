// The journal side of the issue judgment (`ai/jev/issue-relevance.ts`), run
// in the background after `flag_issue` commits a concern: what the judgment
// reads, and what its verdict does — retract the concern below the relevance
// floor, or relabel its severity — committed before it is announced
// (invariant 8). A concern already on GitHub, or edited since it was judged,
// is left as it is.

import type { ThreadEventMessage, WalkthroughIssue, WalkthroughStreamEvent } from "@revv/shared";
import { and, asc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";
import type { IssueCandidate, IssueJudgment } from "../../ai/jev/contracts";
import { type IssueGateInput, judgeIssue } from "../../ai/jev/issue-relevance";
import type { Db } from "../../db";
import { pullRequests } from "../../db/schema/pull-requests";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../db/schema/walkthroughs";
import type { DbError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import type { CacheService } from "../Cache";
import { readCurrentHeadPatch } from "../DiffCache";
import { fitAnchorToPatch } from "../diff-anchors";
import type { JevService } from "../Jev";
import { decodeIssue, deleteIssue } from "./content";

/** Where a verdict is announced, once committed. */
export interface JudgmentSink {
  readonly emit: (event: WalkthroughStreamEvent) => void;
  readonly broadcastThread: (message: ThreadEventMessage) => void;
  /** Lets `add_issue_comment` answer a retracted id with an explanation. */
  readonly markRetracted: (issueId: string) => void;
}

function hunkFor(
  db: Db,
  prId: string,
  candidate: IssueCandidate,
): { readonly hunk: string | null; readonly offDiff: boolean } {
  if (candidate.filePath === null) return { hunk: null, offDiff: false };
  const patch = readCurrentHeadPatch(db, prId, candidate.filePath);
  if (!patch) return { hunk: null, offDiff: false };
  if (candidate.startLine === null) return { hunk: patch, offDiff: false };
  const fit = fitAnchorToPatch(patch, {
    startLine: candidate.startLine,
    endLine: candidate.endLine ?? candidate.startLine,
    side: "RIGHT",
  });
  return { hunk: patch, offDiff: !fit.ok };
}

/** The candidate is already written when it is judged, so it is left out of `existingIssues`. */
export function collectIssueGateInput(
  db: Db,
  walkthroughId: string,
  issueId: string,
  candidate: IssueCandidate,
): IssueGateInput | null {
  const row = db
    .select({ pullRequestId: walkthroughs.pullRequestId })
    .from(walkthroughs)
    .where(eq(walkthroughs.id, walkthroughId))
    .get();
  if (!row) return null;
  const pr = db.select().from(pullRequests).where(eq(pullRequests.id, row.pullRequestId)).get();
  if (!pr) return null;

  const existingIssues = db
    .select({
      title: walkthroughIssues.title,
      description: walkthroughIssues.description,
      filePath: walkthroughIssues.filePath,
    })
    .from(walkthroughIssues)
    .where(
      and(eq(walkthroughIssues.walkthroughId, walkthroughId), ne(walkthroughIssues.id, issueId)),
    )
    .orderBy(asc(walkthroughIssues.order))
    .all()
    .map((issue) => ({
      title: issue.title,
      description: issue.description,
      file: issue.filePath,
    }));

  return { pr, ...hunkFor(db, row.pullRequestId, candidate), existingIssues };
}

/** Apply one judgment atomically, then announce the committed result. */
export function applyJudgment(
  db: Db,
  walkthroughId: string,
  issueId: string,
  candidate: IssueCandidate,
  judgment: IssueJudgment,
  sink: JudgmentSink,
): void {
  const now = new Date().toISOString();
  let retractedThreads: readonly ThreadEventMessage[] = [];
  let retractedIssue = false;
  let updated: WalkthroughIssue | null = null;

  db.transaction(() => {
    const row = db.select().from(walkthroughIssues).where(eq(walkthroughIssues.id, issueId)).get();
    if (!row || row.walkthroughId !== walkthroughId || row.submittedAt !== null) return;
    if (row.description !== candidate.description || row.severity !== candidate.severity) return;

    if (judgment.discard) {
      retractedThreads = deleteIssue(db, issueId);
      retractedIssue = true;
      return;
    }

    const severity = judgment.severity ?? row.severity;
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
    for (const message of retractedThreads) sink.broadcastThread(message);
    sink.emit({ type: "issue:deleted", data: { id: issueId } });
  } else if (updated !== null) {
    sink.emit({ type: "issue", data: updated });
  }
}

/** Judge a committed concern and apply the verdict. A judgment Jev can't make leaves it as written. */
export function gateIssue(
  db: Db,
  walkthroughId: string,
  issueId: string,
  candidate: IssueCandidate,
  sink: JudgmentSink,
): Effect.Effect<void, DbError, JevService | CacheService> {
  return Effect.gen(function* () {
    const input = yield* dbTry("issue judgment: gather", () =>
      collectIssueGateInput(db, walkthroughId, issueId, candidate),
    );
    if (input === null) return;
    const judgment = yield* judgeIssue(walkthroughId, issueId, candidate, input);
    if (judgment === null) return;
    yield* dbTry("issue judgment: apply", () =>
      applyJudgment(db, walkthroughId, issueId, candidate, judgment, sink),
    );
  });
}
