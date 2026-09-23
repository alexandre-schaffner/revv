import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db";
import { prDiffFiles } from "../../db/schema/pr-diff-files";
import { pullRequests } from "../../db/schema/pull-requests";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { fitAnchorToPatch } from "../../services/diff-anchors";
import type { IssueCandidate } from "./contracts";

export interface IssueGateInput {
  readonly pr: typeof pullRequests.$inferSelect;
  readonly hunk: string | null;
  readonly offDiff: boolean;
  readonly existingIssues: ReadonlyArray<{
    readonly title: string;
    readonly description: string;
    readonly file: string | null;
  }>;
}

function hunkFor(
  db: Db,
  prId: string,
  candidate: IssueCandidate,
): { readonly hunk: string | null; readonly offDiff: boolean } {
  if (candidate.filePath === null) return { hunk: null, offDiff: false };
  const row = db
    .select({ patch: prDiffFiles.patch })
    .from(prDiffFiles)
    .where(and(eq(prDiffFiles.prId, prId), eq(prDiffFiles.path, candidate.filePath)))
    .get();
  if (!row?.patch) return { hunk: null, offDiff: false };
  if (candidate.startLine === null) return { hunk: row.patch, offDiff: false };
  const fit = fitAnchorToPatch(row.patch, {
    startLine: candidate.startLine,
    endLine: candidate.endLine ?? candidate.startLine,
    side: "RIGHT",
  });
  return { hunk: row.patch, offDiff: !fit.ok };
}

/** Gather the stable DB context a single judgment depends on. */
export function collectIssueGateInput(
  db: Db,
  walkthroughId: string,
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
    .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
    .orderBy(asc(walkthroughIssues.order))
    .all()
    .map((issue) => ({
      title: issue.title,
      description: issue.description,
      file: issue.filePath,
    }));

  return { pr, ...hunkFor(db, row.pullRequestId, candidate), existingIssues };
}
