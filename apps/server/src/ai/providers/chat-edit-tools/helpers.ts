// ── chat-edit-helpers ────────────────────────────────────────────────────────
//
// Shared helper functions and types used by chat-edit tool handlers.

import type {
  RatingAxis,
  RatingCitation,
  WalkthroughBlock,
  WalkthroughIssue,
  WalkthroughRating,
} from "@revv/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db";
import type { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import type { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import type { ChatEditToolResult } from "./spec";

// ── Result helpers ──────────────────────────────────────────────────────────

export function ok(text: string): ChatEditToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function fail(text: string): ChatEditToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ── Walkthrough resolution ──────────────────────────────────────────────────

export type WalkthroughRow = typeof walkthroughs.$inferSelect;

/**
 * Returns the latest `status='complete'` walkthrough row for the PR, or null
 * if none exists yet. Resolved freshly on every handler call so chat sessions
 * that outlive a regenerate naturally retarget the new walkthrough.
 */
export function resolveActiveWalkthroughId(db: Db, prId: string): WalkthroughRow | null {
  return (
    db
      .select()
      .from(walkthroughs)
      .where(and(eq(walkthroughs.pullRequestId, prId), eq(walkthroughs.status, "complete")))
      .orderBy(desc(walkthroughs.generatedAt))
      .limit(1)
      .get() ?? null
  );
}

/**
 * Inside-transaction guard: re-read the row by id and assert it is still
 * `status='complete'`. Defends against the race where another process
 * supersedes the walkthrough between the outer resolve and our write.
 */
export function assertStillComplete(
  db: Db,
  walkthroughId: string,
): { row: WalkthroughRow } | { error: string } {
  const row = db.select().from(walkthroughs).where(eq(walkthroughs.id, walkthroughId)).get();
  if (!row) {
    return {
      error: `Walkthrough ${walkthroughId} no longer exists. It may have been superseded — call get_walkthrough_for_edit again to retarget.`,
    };
  }
  if (row.status !== "complete") {
    return {
      error: `Walkthrough ${walkthroughId} has status='${row.status}' (expected 'complete'). Edits are only allowed on completed walkthroughs. Call get_walkthrough_for_edit again to retarget.`,
    };
  }
  return { row };
}

export function stampLastEdited(db: Db, walkthroughId: string, actor: string): void {
  db.update(walkthroughs)
    .set({ lastEditedAt: new Date().toISOString(), lastEditedBy: actor })
    .where(eq(walkthroughs.id, walkthroughId))
    .run();
}

// ── Block construction ──────────────────────────────────────────────────────
//
// The variant-count, empty/size validation, and typed-block construction are
// shared with the generation pipeline in `../walkthrough-blocks` so the two
// MCP write paths can never drift (CLAUDE.md #2, #13). Handlers import
// `blockVariantCount`, `emptyBlockError`, and `buildBlock` from there directly.

// ── Issue-blockIds JSON helpers ─────────────────────────────────────────────

export function parseBlockIds(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  } catch {
    /* corrupt JSON */
  }
  return [];
}

/**
 * For each issue whose `blockIds` JSON contains any of `blockIds`, return the
 * issue row + the surviving blockIds array (after subtraction). Used by
 * delete_block / delete_semantic_step to detect orphans before commit.
 */
export function findIssuesReferencingBlocks(
  db: Db,
  walkthroughId: string,
  blockIds: string[],
): Array<{
  row: typeof walkthroughIssues.$inferSelect;
  survivingBlockIds: string[];
}> {
  if (blockIds.length === 0) return [];
  const allIssues = db
    .select()
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
    .all();
  const removeSet = new Set(blockIds);
  const affected: Array<{
    row: typeof walkthroughIssues.$inferSelect;
    survivingBlockIds: string[];
  }> = [];
  for (const issue of allIssues) {
    const ids = parseBlockIds(issue.blockIds);
    if (!ids.some((id) => removeSet.has(id))) continue;
    const survivors = ids.filter((id) => !removeSet.has(id));
    affected.push({ row: issue, survivingBlockIds: survivors });
  }
  return affected;
}

// ── Rating decode (matches walkthrough-tools.ts payload shape) ──────────────

export function decodeRating(row: typeof walkthroughRatings.$inferSelect): WalkthroughRating {
  const citations: RatingCitation[] = parseCitations(row.citations);
  const blockIds = parseBlockIds(row.blockIds);
  return {
    axis: row.axis as RatingAxis,
    verdict: row.verdict as WalkthroughRating["verdict"],
    confidence: row.confidence as WalkthroughRating["confidence"],
    rationale: row.rationale,
    details: row.details,
    citations,
    blockIds,
  };
}

export function parseCitations(json: string): RatingCitation[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    const out: RatingCitation[] = [];
    for (const c of v) {
      if (c && typeof c === "object") {
        const cc = c as Record<string, unknown>;
        if (
          typeof cc.filePath === "string" &&
          typeof cc.startLine === "number" &&
          typeof cc.endLine === "number"
        ) {
          out.push({
            filePath: cc.filePath,
            startLine: cc.startLine,
            endLine: cc.endLine,
            ...(typeof cc.note === "string" ? { note: cc.note } : {}),
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function decodeBlock(row: typeof walkthroughBlocks.$inferSelect): WalkthroughBlock | null {
  try {
    const v = JSON.parse(row.data) as WalkthroughBlock;
    return v;
  } catch {
    return null;
  }
}

export function decodeIssue(row: typeof walkthroughIssues.$inferSelect): WalkthroughIssue {
  const blockIds = parseBlockIds(row.blockIds);
  return {
    id: row.id,
    severity: row.severity as WalkthroughIssue["severity"],
    title: row.title,
    description: row.description,
    blockIds,
    ...(row.filePath !== null ? { filePath: row.filePath } : {}),
    ...(row.startLine !== null ? { startLine: row.startLine } : {}),
    ...(row.endLine !== null ? { endLine: row.endLine } : {}),
    ...(row.submittedAt !== null ? { submittedAt: row.submittedAt } : {}),
  };
}
