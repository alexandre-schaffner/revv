// What other features read of a PR's reviews: the latest finished one with
// its open concerns (stack overlays, the stack brief and walkthrough agents'
// stack context), and the current one for the chat prompt.

import type { RiskLevel, WalkthroughMode, WalkthroughStackSnapshot } from "@revv/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { ChatWalkthroughContext } from "../../ai/prompts/chat";
import type { Db } from "../../db";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { type DiffFingerprint, walkthroughs } from "../../db/schema/walkthroughs";
import { finishedReview, latestCompleteWalkthrough } from "./content";

const MAX_CHAT_PROMPT_ISSUES = 40;

/** A review's one-line gist: the first line of its summary, markdown stripped. */
export function takeawayOf(summary: string): string | null {
  for (const raw of summary.split("\n")) {
    const line = raw
      .replace(/^[#>*\-\s]+/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (line) return line;
  }
  return null;
}

export interface FinishedReview {
  readonly id: string;
  readonly prId: string;
  readonly prHeadSha: string;
  readonly mode: WalkthroughMode;
  readonly riskLevel: RiskLevel;
  readonly summary: string;
  readonly takeaway: string | null;
  readonly sentiment: string | null;
  readonly stackContext: WalkthroughStackSnapshot | null;
  readonly diffFingerprint: DiffFingerprint | null;
  /** Imported from an earlier head's review by a restack, with no agent run. */
  readonly carried: boolean;
  /** Concerns still open, in reading order. */
  readonly openIssues: ReadonlyArray<{ readonly title: string; readonly severity: string }>;
}

/** Each PR's latest finished review (see `finishedReview`), superseded since or not. */
export function latestFinishedReviews(
  db: Db,
  prIds: readonly string[],
): Map<string, FinishedReview> {
  if (prIds.length === 0) return new Map();
  const rows = db
    .select({
      id: walkthroughs.id,
      prId: walkthroughs.pullRequestId,
      prHeadSha: walkthroughs.prHeadSha,
      mode: walkthroughs.mode,
      riskLevel: walkthroughs.riskLevel,
      summary: walkthroughs.summary,
      sentiment: walkthroughs.sentiment,
      stackContext: walkthroughs.stackContext,
      diffFingerprint: walkthroughs.diffFingerprint,
      carriedFrom: walkthroughs.carriedFromWalkthroughId,
    })
    .from(walkthroughs)
    .where(and(inArray(walkthroughs.pullRequestId, [...prIds]), finishedReview()))
    .orderBy(desc(walkthroughs.generatedAt))
    .all();
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.prId)) latest.set(row.prId, row);

  const ids = [...latest.values()].map((row) => row.id);
  const issues =
    ids.length === 0
      ? []
      : db
          .select({
            walkthroughId: walkthroughIssues.walkthroughId,
            title: walkthroughIssues.title,
            severity: walkthroughIssues.severity,
          })
          .from(walkthroughIssues)
          .where(
            and(
              inArray(walkthroughIssues.walkthroughId, ids),
              eq(walkthroughIssues.resolutionStatus, "open"),
            ),
          )
          .orderBy(walkthroughIssues.order)
          .all();
  const issuesOf = Map.groupBy(issues, (issue) => issue.walkthroughId);

  return new Map(
    [...latest].map(([prId, row]) => [
      prId,
      {
        id: row.id,
        prId,
        prHeadSha: row.prHeadSha,
        mode: row.mode,
        riskLevel: row.riskLevel as RiskLevel,
        summary: row.summary,
        takeaway: takeawayOf(row.summary),
        sentiment: row.sentiment,
        stackContext: row.stackContext,
        diffFingerprint: row.diffFingerprint,
        carried: row.carriedFrom !== null,
        openIssues: (issuesOf.get(row.id) ?? []).map(({ title, severity }) => ({
          title,
          severity,
        })),
      },
    ]),
  );
}

/** The PR's current review as the chat prompt carries it, or null before one completes. */
export function chatContextOf(db: Db, prId: string): ChatWalkthroughContext | null {
  const row = latestCompleteWalkthrough(db, prId);
  if (!row) return null;
  const issues = db
    .select()
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, row.id))
    .orderBy(walkthroughIssues.order)
    .limit(MAX_CHAT_PROMPT_ISSUES)
    .all();
  return {
    summary: row.summary ?? "",
    riskLevel: row.riskLevel ?? "low",
    sentiment: row.sentiment ?? null,
    issues: issues.map((i) => ({
      severity: i.severity,
      title: i.title,
      description: i.description,
      filePath: i.filePath,
      startLine: i.startLine,
      endLine: i.endLine,
    })),
  };
}
