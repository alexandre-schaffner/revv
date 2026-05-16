// ─── walkthrough-tool-helpers ────────────────────────────────────────────────
//
// Shared helpers for the walkthrough pipeline MCP tool handlers: phase
// comparison, result constructors, JSON unwrapping, DB row loading, and
// comment-pairing validation.

import type { WalkthroughPipelinePhase } from "@revv/shared";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../../db";
import { commentThreads } from "../../../db/schema/comment-threads";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import type { WalkthroughToolResult } from "./spec";

// ── Phase helpers ────────────────────────────────────────────────────────────

export const PHASE_ORDER: Record<WalkthroughPipelinePhase, number> = {
  none: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};

export function phaseAtLeast(
  phase: WalkthroughPipelinePhase,
  min: WalkthroughPipelinePhase,
): boolean {
  return PHASE_ORDER[phase] >= PHASE_ORDER[min];
}

export function phaseAtMost(
  phase: WalkthroughPipelinePhase,
  max: WalkthroughPipelinePhase,
): boolean {
  return PHASE_ORDER[phase] <= PHASE_ORDER[max];
}

export function errorResult(text: string): WalkthroughToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function okResult(text: string): WalkthroughToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Some agents (notably weaker tool-using models routed via opencode) emit
 * single-field markdown payloads as a JSON-wrapped string — e.g. passing
 * `{markdown: '{"markdown": "Solid engineering..."}'}` instead of
 * `{markdown: 'Solid engineering...'}`. The double-wrap leaks the literal
 * `{"markdown": "..."}` braces into the rendered UI. Detect that exact shape
 * and unwrap to the inner string. We only unwrap when the value parses as a
 * JSON object with a single string field matching the expected key, which
 * avoids false positives (legitimate prose that happens to start with `{`
 * won't satisfy both conditions).
 */
export function unwrapJsonWrappedString(value: string, expectedKey: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return value;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return value;
  }
  const inner = (parsed as Record<string, unknown>)[expectedKey];
  if (typeof inner !== "string") return value;
  return inner;
}

/**
 * Read the walkthrough row for a tool call. Throws a tool-level error result
 * if the row is missing — the orchestrator is supposed to have created the
 * row before the agent starts calling tools.
 */
export function loadWalkthroughRow(
  db: Db,
  walkthroughId: string,
): typeof walkthroughs.$inferSelect | null {
  return db.select().from(walkthroughs).where(eq(walkthroughs.id, walkthroughId)).get() ?? null;
}

/** Canonical block id derived from the composite identity. */
export function blockIdFor(
  walkthroughId: string,
  semanticStepIndex: number,
  stepIndex: number,
): string {
  return `block-${walkthroughId}-${semanticStepIndex}-${stepIndex}`;
}

// ── Comment-pairing validation ───────────────────────────────────────────────
//
// Single source of truth for the "warning/critical line-anchored issues must
// have ≥1 inline comment" rule (doctrine invariant #12). Both
// `complete_walkthrough` (tool-surface gate) and `WalkthroughJobs`
// (orchestrator gate before transitioning `status='complete'`) call this.
// They MUST stay in lockstep — otherwise the agent can finish at phase=D
// with no comments and the orchestrator silently marks the walkthrough
// `complete`.

export interface MissingInlineComment {
  id: string;
  severity: "warning" | "critical";
  title: string;
  filePath: string;
  startLine: number;
}

/**
 * Returns the list of warning/critical, line-anchored issues that have no
 * inline comment thread yet. Empty array means the comment-pairing
 * invariant holds — `complete_walkthrough` may proceed and the orchestrator
 * may transition `status` to `'complete'`.
 *
 * Exempt by design (returned as "satisfied"):
 *   - severity = 'info'           (nitpicks; reviewers want a clean panel)
 *   - filePath / startLine = null (PR-wide concerns; no anchor possible)
 */
export function findIssuesMissingInlineComment(
  db: Db,
  walkthroughId: string,
): MissingInlineComment[] {
  const requiresCommentIssues = db
    .select({
      id: walkthroughIssues.id,
      title: walkthroughIssues.title,
      severity: walkthroughIssues.severity,
      filePath: walkthroughIssues.filePath,
      startLine: walkthroughIssues.startLine,
    })
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
    .all()
    .filter(
      (
        i,
      ): i is typeof i & {
        filePath: string;
        startLine: number;
        severity: "warning" | "critical";
      } =>
        i.filePath !== null &&
        i.startLine !== null &&
        (i.severity === "warning" || i.severity === "critical"),
    );

  if (requiresCommentIssues.length === 0) return [];

  const issueIds = requiresCommentIssues.map((i) => i.id);
  const commentedRows = db
    .select({ walkthroughIssueId: commentThreads.walkthroughIssueId })
    .from(commentThreads)
    .where(inArray(commentThreads.walkthroughIssueId, issueIds))
    .all();
  const commentedSet = new Set(
    commentedRows.map((r) => r.walkthroughIssueId).filter((v): v is string => v !== null),
  );
  return requiresCommentIssues
    .filter((i) => !commentedSet.has(i.id))
    .map((i) => ({
      id: i.id,
      severity: i.severity,
      title: i.title,
      filePath: i.filePath,
      startLine: i.startLine,
    }));
}

/**
 * Renders the canonical error message for a missing-inline-comment list.
 * Used by both `complete_walkthrough` (returned to the agent) and the
 * orchestrator (for log messages on the auto-continuation path). Keeping
 * the format unified means the agent sees the same wording whether the
 * gate trips at the tool surface or surfaces via `get_walkthrough_state`
 * on a resumed run.
 */
export function renderMissingInlineCommentError(uncommented: MissingInlineComment[]): string {
  const list = uncommented
    .map((i) => `  - id=${i.id} [${i.severity}] (${i.filePath}:${i.startLine}) "${i.title}"`)
    .join("\n");
  return `Error: ${uncommented.length} flagged issue(s) at severity 'warning' or 'critical' have no inline comment. For each, you MUST also call add_issue_comment with the matching issue_id. Missing:\n${list}\n\nCall add_issue_comment for each, then retry complete_walkthrough. (Severity 'info' issues do not require an inline comment.)`;
}
