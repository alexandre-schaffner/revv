import { isExternalAgentProvider, isLowSignalScore, type WalkthroughIssue } from "@revv/shared";
import type { walkthroughIssues } from "../db/schema/walkthrough-issues";

export interface RegeneratedIssueIdentity {
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly filePath: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

export function isSameResolvedFinding(
  row: RegeneratedIssueIdentity & { readonly resolutionStatus: string },
  next: RegeneratedIssueIdentity,
): boolean {
  return (
    row.resolutionStatus !== "open" &&
    row.severity === next.severity &&
    row.title === next.title &&
    row.description === next.description &&
    row.filePath === next.filePath &&
    row.startLine === next.startLine &&
    row.endLine === next.endLine
  );
}

function stringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/** Canonical database-row decoder shared by REST snapshots and MCP payloads. */
export function decodeWalkthroughIssue(
  row: typeof walkthroughIssues.$inferSelect,
): WalkthroughIssue {
  const resolutionEvidence = stringArray(row.resolutionEvidence);
  return {
    id: row.id,
    severity: row.severity as WalkthroughIssue["severity"],
    title: row.title,
    description: row.description,
    blockIds: stringArray(row.blockIds),
    ...(row.filePath !== null ? { filePath: row.filePath } : {}),
    ...(row.startLine !== null ? { startLine: row.startLine } : {}),
    ...(row.endLine !== null ? { endLine: row.endLine } : {}),
    ...(row.submittedAt !== null ? { submittedAt: row.submittedAt } : {}),
    // Absent, not null, when unscored — exactOptionalPropertyTypes keeps
    // "never scored" from reading as low signal.
    ...(row.advisoryScore !== null
      ? { advisoryScore: row.advisoryScore, lowSignal: isLowSignalScore(row.advisoryScore) }
      : {}),
    ...(row.resolutionStatus === "addressed" || row.resolutionStatus === "wont_fix"
      ? { resolutionStatus: row.resolutionStatus }
      : {}),
    ...(row.resolutionExplanation !== null
      ? { resolutionExplanation: row.resolutionExplanation }
      : {}),
    ...(resolutionEvidence.length > 0 ? { resolutionEvidence } : {}),
    ...(row.resolvingCommitSha !== null ? { resolvingCommitSha: row.resolvingCommitSha } : {}),
    ...(row.resolvedAt !== null ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.resolvedBy !== null && isExternalAgentProvider(row.resolvedBy)
      ? { resolvedBy: row.resolvedBy }
      : {}),
  };
}
