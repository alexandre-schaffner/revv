// ── chat-edit-helpers ────────────────────────────────────────────────────────
//
// `runChatEdit` is every chat edit's frame: resolve the target walkthrough,
// re-check it inside the transaction, apply the edit, stamp it, and publish
// what changed only after the commit (invariants 7 and 8). A handler supplies
// only the edit.

import type { ThreadEventMessage, WalkthroughIssue, WalkthroughStreamEvent } from "@revv/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../../db";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import {
  decodeIssue,
  decodeStringArray,
  latestCompleteWalkthrough,
  type WalkthroughRow,
} from "../../../services/walkthrough/content";
import type { ChatEditToolResult, ChatWalkthroughEditContext } from "./spec";

export function ok(text: string): ChatEditToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function fail(text: string): ChatEditToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const NO_COMPLETE_WALKTHROUGH =
  "No complete walkthrough exists for this PR yet. Ask the user to generate one first.";

/** What an edit did, or why it refused. A refusal must not have written anything. */
export type ChatEdit =
  | { readonly refused: string }
  | {
      readonly message: string;
      /** Nothing was written: no stamp, nothing published. */
      readonly unchanged?: boolean;
      readonly events?: readonly WalkthroughStreamEvent[];
      readonly threadEvents?: readonly ThreadEventMessage[];
    };

export function runChatEdit(
  ctx: ChatWalkthroughEditContext,
  edit: (walkthrough: WalkthroughRow) => ChatEdit,
): ChatEditToolResult {
  const target = latestCompleteWalkthrough(ctx.db, ctx.prId);
  if (!target) return fail(NO_COMPLETE_WALKTHROUGH);

  const outcome = ctx.db.transaction((): ChatEdit => {
    // Another process may have superseded it since the lookup above.
    const row = ctx.db.select().from(walkthroughs).where(eq(walkthroughs.id, target.id)).get();
    if (!row) {
      return {
        refused: `Walkthrough ${target.id} no longer exists. It may have been superseded — call get_walkthrough_for_edit again to retarget.`,
      };
    }
    if (row.status !== "complete") {
      return {
        refused: `Walkthrough ${target.id} has status='${row.status}' (expected 'complete'). Edits are only allowed on completed walkthroughs. Call get_walkthrough_for_edit again to retarget.`,
      };
    }
    const result = edit(row);
    if (!("refused" in result) && !result.unchanged) {
      ctx.db
        .update(walkthroughs)
        .set({ lastEditedAt: new Date().toISOString(), lastEditedBy: ctx.actor })
        .where(eq(walkthroughs.id, target.id))
        .run();
    }
    return result;
  });

  if ("refused" in outcome) return fail(outcome.refused);
  if (!outcome.unchanged) {
    for (const msg of outcome.threadEvents ?? []) ctx.broadcastThreadEvent(msg);
    if (outcome.events && outcome.events.length > 0) ctx.publishEdit(target.id, outcome.events);
  }
  return ok(outcome.message);
}

/**
 * Drop `blockIds` from the issues that cite them, ahead of deleting those
 * blocks. Refused when a cited issue was submitted to GitHub (immutable), or
 * when a warning or critical issue would be left citing no block. Returns the
 * issues as rewritten.
 */
export function scrubBlockReferences(
  db: Db,
  walkthroughId: string,
  blockIds: readonly string[],
  target: string,
): { readonly refused: string } | { readonly issues: WalkthroughIssue[] } {
  if (blockIds.length === 0) return { issues: [] };
  const removed = new Set(blockIds);
  const affected = db
    .select()
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
    .all()
    .flatMap((row) => {
      const ids = decodeStringArray(row.blockIds);
      if (!ids.some((id) => removed.has(id))) return [];
      return [{ row, surviving: ids.filter((id) => !removed.has(id)) }];
    });

  const titles = (rows: readonly { readonly row: { readonly title: string } }[]) =>
    rows.map((a) => `'${a.row.title}'`).join(", ");
  const submitted = affected.filter((a) => a.row.submittedAt !== null);
  if (submitted.length > 0) {
    return {
      refused: `Error: cannot delete ${target} — ${submitted.length} GitHub-submitted issue(s) reference it (${titles(submitted)}). Submitted issues are immutable.`,
    };
  }
  const orphaned = affected.filter(
    (a) =>
      a.surviving.length === 0 && (a.row.severity === "warning" || a.row.severity === "critical"),
  );
  if (orphaned.length > 0) {
    return {
      refused: `Error: cannot delete ${target} — ${orphaned.length} warning/critical issue(s) would be left citing no block (${titles(orphaned)}). Delete those issues first, or move their references to other blocks via update_issue.`,
    };
  }

  return {
    issues: affected.map(({ row, surviving }) => {
      const blockIdsJson = JSON.stringify(surviving);
      db.update(walkthroughIssues)
        .set({ blockIds: blockIdsJson })
        .where(eq(walkthroughIssues.id, row.id))
        .run();
      return decodeIssue({ ...row, blockIds: blockIdsJson });
    }),
  };
}
