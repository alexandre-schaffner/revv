// ── chat-edit-content-handlers ───────────────────────────────────────────────
//
// Handlers for overview, sentiment, semantic steps, and blocks.

import type { WalkthroughBlock, WalkthroughIssue, WalkthroughSemanticStep } from "@revv/shared";
import { and, eq, sql } from "drizzle-orm";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import type {
  AddBlockInput,
  AddSemanticStepEditInput,
  ChatEditToolHandler,
  ChatEditToolResult,
  DeleteBlockInput,
  DeleteSemanticStepInput,
  UpdateBlockInput,
  UpdateOverviewInput,
  UpdateSemanticStepInput,
  UpdateSentimentInput,
} from "./spec";
import {
  assertStillComplete,
  blockContentVariantCount,
  buildBlock,
  decodeIssue,
  fail,
  findIssuesReferencingBlocks,
  ok,
  resolveActiveWalkthroughId,
  stampLastEdited,
} from "./helpers";
import { blockIdFor, unwrapJsonWrappedString } from "../walkthrough-tools";

// ── Tool: update_overview ───────────────────────────────────────────────────

export const updateOverviewHandler: ChatEditToolHandler<UpdateOverviewInput> = async (ctx, input) => {
  const summary = input.summary != null ? unwrapJsonWrappedString(input.summary, "summary") : null;
  const riskLevel = input.risk_level ?? null;
  if (summary === null && riskLevel === null) {
    return fail(
      "Error: update_overview needs at least one of summary or risk_level. Both were omitted.",
    );
  }

  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) {
    return fail(
      "No complete walkthrough exists for this PR yet. Ask the user to generate one first.",
    );
  }
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let finalSummary = "";
  let finalRisk: "low" | "medium" | "high" = "low";
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }
    const patch: { summary?: string; riskLevel?: string } = {};
    if (summary !== null) patch.summary = summary;
    if (riskLevel !== null) patch.riskLevel = riskLevel;
    ctx.db.update(walkthroughs).set(patch).where(eq(walkthroughs.id, walkthroughId)).run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);
    finalSummary = summary ?? guarded.row.summary;
    finalRisk = (riskLevel ?? guarded.row.riskLevel) as "low" | "medium" | "high";
  });
  if (result) return result;

  ctx.emit(walkthroughId, {
    type: "summary",
    data: { summary: finalSummary, riskLevel: finalRisk },
  });
  return ok(
    `Overview updated. risk=${finalRisk}${summary !== null ? ` summary=${JSON.stringify(finalSummary.slice(0, 80))}…` : ""}.`,
  );
};

// ── Tool: add_semantic_step ─────────────────────────────────────────────────

export const addSemanticStepEditHandler: ChatEditToolHandler<AddSemanticStepEditInput> = async (
  ctx,
  input,
) => {
  if (blockContentVariantCount(input.initial_block) !== 1) {
    return fail(
      "Error: add_semantic_step.initial_block requires exactly one of { markdown, code, diff }.",
    );
  }
  const title = input.title.trim();
  if (title.length === 0) {
    return fail("Error: add_semantic_step requires a non-empty title.");
  }

  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) {
    return fail("No complete walkthrough exists for this PR yet.");
  }
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let emitChapter: WalkthroughSemanticStep | null = null;
  let emitBlock: WalkthroughBlock | null = null;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const existing = ctx.db
      .select({ id: walkthroughSemanticSteps.id })
      .from(walkthroughSemanticSteps)
      .where(
        and(
          eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
          eq(walkthroughSemanticSteps.semanticStepIndex, input.semantic_step_index),
        ),
      )
      .get();
    if (existing) {
      result = fail(
        `Error: a chapter already exists at semantic_step_index=${input.semantic_step_index}. Use update_semantic_step to modify it.`,
      );
      return;
    }

    const now = new Date().toISOString();
    const chapterId = `semantic-${walkthroughId}-${input.semantic_step_index}`;
    ctx.db
      .insert(walkthroughSemanticSteps)
      .values({
        id: chapterId,
        walkthroughId,
        semanticStepIndex: input.semantic_step_index,
        title,
        summary: input.summary ?? null,
        createdAt: now,
      })
      .run();

    const blockId = blockIdFor(walkthroughId, input.semantic_step_index, 0);
    const built = buildBlock(blockId, input.semantic_step_index, 0, {
      ...(input.initial_block.markdown != null ? { markdown: input.initial_block.markdown } : {}),
      ...(input.initial_block.code != null ? { code: input.initial_block.code } : {}),
      ...(input.initial_block.diff != null ? { diff: input.initial_block.diff } : {}),
    });
    ctx.db
      .insert(walkthroughBlocks)
      .values({
        id: blockId,
        walkthroughId,
        phase: "diff_analysis",
        order: input.semantic_step_index * 10000,
        semanticStepIndex: input.semantic_step_index,
        stepIndex: 0,
        type: built.type,
        data: built.data,
        createdAt: now,
      })
      .run();

    stampLastEdited(ctx.db, walkthroughId, ctx.actor);

    emitChapter = {
      semanticStepIndex: input.semantic_step_index,
      title,
      summary: input.summary ?? null,
    };
    emitBlock = built.block;
  });
  if (result) return result;
  if (!emitChapter || !emitBlock) {
    return fail("Internal error: add_semantic_step did not persist correctly.");
  }

  ctx.emit(walkthroughId, { type: "semantic-step", data: emitChapter });
  ctx.emit(walkthroughId, { type: "block", data: emitBlock });
  return ok(`Chapter ${input.semantic_step_index} ('${title}') inserted with its first block.`);
};

// ── Tool: update_semantic_step ──────────────────────────────────────────────

export const updateSemanticStepHandler: ChatEditToolHandler<UpdateSemanticStepInput> = async (
  ctx,
  input,
) => {
  const hasTitle = typeof input.title === "string" && input.title.length > 0;
  const hasSummary = "summary" in input && input.summary !== undefined;
  if (!hasTitle && !hasSummary) {
    return fail("Error: update_semantic_step needs at least one of title or summary.");
  }

  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let emitChapter: WalkthroughSemanticStep | null = null;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const existing = ctx.db
      .select()
      .from(walkthroughSemanticSteps)
      .where(
        and(
          eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
          eq(walkthroughSemanticSteps.semanticStepIndex, input.semantic_step_index),
        ),
      )
      .get();
    if (!existing) {
      result = fail(
        `Error: no chapter exists at semantic_step_index=${input.semantic_step_index}.`,
      );
      return;
    }

    const newTitle = hasTitle ? (input.title as string).trim() : existing.title;
    if (newTitle.length === 0) {
      result = fail("Error: title cannot be empty.");
      return;
    }
    const newSummary = hasSummary ? (input.summary ?? null) : existing.summary;

    ctx.db
      .update(walkthroughSemanticSteps)
      .set({ title: newTitle, summary: newSummary })
      .where(eq(walkthroughSemanticSteps.id, existing.id))
      .run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);

    emitChapter = {
      semanticStepIndex: input.semantic_step_index,
      title: newTitle,
      summary: newSummary,
    };
  });
  if (result) return result;
  if (!emitChapter) {
    return fail("Internal error: update_semantic_step did not persist.");
  }

  ctx.emit(walkthroughId, { type: "semantic-step", data: emitChapter });
  return ok(`Chapter ${input.semantic_step_index} updated.`);
};

// ── Tool: delete_semantic_step ──────────────────────────────────────────────

export const deleteSemanticStepHandler: ChatEditToolHandler<DeleteSemanticStepInput> = async (
  ctx,
  input,
) => {
  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  const deletedBlockEvents: Array<{
    id: string;
    semanticStepIndex: number;
    stepIndex: number;
  }> = [];
  const updatedIssueEvents: WalkthroughIssue[] = [];

  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const chapter = ctx.db
      .select()
      .from(walkthroughSemanticSteps)
      .where(
        and(
          eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
          eq(walkthroughSemanticSteps.semanticStepIndex, input.semantic_step_index),
        ),
      )
      .get();
    if (!chapter) {
      result = fail(
        `Error: no chapter exists at semantic_step_index=${input.semantic_step_index}.`,
      );
      return;
    }

    const chapterBlocks = ctx.db
      .select()
      .from(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, walkthroughId),
          eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
        ),
      )
      .all();
    const blockIds = chapterBlocks.map((b) => b.id);

    const affected = findIssuesReferencingBlocks(ctx.db, walkthroughId, blockIds);

    // Pre-validate: refuse if any affected issue has been submitted to
    // GitHub, or if removing these blocks would orphan a warning/critical
    // issue (no remaining blockIds).
    const submitted = affected.filter((a) => a.row.submittedAt !== null);
    if (submitted.length > 0) {
      const titles = submitted.map((a) => `'${a.row.title}'`).join(", ");
      result = fail(
        `Error: cannot delete chapter — ${submitted.length} issue(s) referencing its blocks have been submitted to GitHub (${titles}). Submitted issues are immutable.`,
      );
      return;
    }
    const orphaning = affected.filter(
      (a) =>
        a.survivingBlockIds.length === 0 &&
        (a.row.severity === "warning" || a.row.severity === "critical"),
    );
    if (orphaning.length > 0) {
      const titles = orphaning.map((a) => `'${a.row.title}'`).join(", ");
      result = fail(
        `Error: cannot delete chapter — ${orphaning.length} warning/critical issue(s) reference only blocks inside it (${titles}). Delete those issues first, or move them to other blocks via update_issue.`,
      );
      return;
    }

    // Apply: update each affected issue's blockIds, then delete blocks +
    // chapter.
    for (const a of affected) {
      ctx.db
        .update(walkthroughIssues)
        .set({ blockIds: JSON.stringify(a.survivingBlockIds) })
        .where(eq(walkthroughIssues.id, a.row.id))
        .run();
      const updated = {
        ...a.row,
        blockIds: JSON.stringify(a.survivingBlockIds),
      };
      updatedIssueEvents.push(decodeIssue(updated));
    }

    ctx.db
      .delete(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, walkthroughId),
          eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
        ),
      )
      .run();
    ctx.db
      .delete(walkthroughSemanticSteps)
      .where(eq(walkthroughSemanticSteps.id, chapter.id))
      .run();

    for (const b of chapterBlocks) {
      deletedBlockEvents.push({
        id: b.id,
        semanticStepIndex: b.semanticStepIndex,
        stepIndex: b.stepIndex,
      });
    }

    stampLastEdited(ctx.db, walkthroughId, ctx.actor);
  });
  if (result) return result;

  for (const ev of deletedBlockEvents) ctx.emit(walkthroughId, { type: "block:deleted", data: ev });
  for (const issue of updatedIssueEvents) ctx.emit(walkthroughId, { type: "issue", data: issue });
  ctx.emit(walkthroughId, {
    type: "semantic-step:deleted",
    data: { semanticStepIndex: input.semantic_step_index },
  });
  return ok(
    `Chapter ${input.semantic_step_index} deleted (${deletedBlockEvents.length} block(s); ${updatedIssueEvents.length} issue(s) had references scrubbed).`,
  );
};

// ── Tool: add_block ─────────────────────────────────────────────────────────

export const addBlockHandler: ChatEditToolHandler<AddBlockInput> = async (ctx, input) => {
  if (blockContentVariantCount(input.content) !== 1) {
    return fail("Error: add_block.content requires exactly one of { markdown, code, diff }.");
  }

  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let emitBlock: WalkthroughBlock | null = null;
  let resolvedStepIndex = 0;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const parent = ctx.db
      .select({ id: walkthroughSemanticSteps.id })
      .from(walkthroughSemanticSteps)
      .where(
        and(
          eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
          eq(walkthroughSemanticSteps.semanticStepIndex, input.semantic_step_index),
        ),
      )
      .get();
    if (!parent) {
      result = fail(
        `Error: no chapter exists at semantic_step_index=${input.semantic_step_index}. Call add_semantic_step first.`,
      );
      return;
    }

    // Resolve target step_index. Either explicit (collision-checked) or
    // append (MAX+1).
    let stepIndex: number;
    if (input.step_index != null) {
      const conflict = ctx.db
        .select({ id: walkthroughBlocks.id })
        .from(walkthroughBlocks)
        .where(
          and(
            eq(walkthroughBlocks.walkthroughId, walkthroughId),
            eq(walkthroughBlocks.phase, "diff_analysis"),
            eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
            eq(walkthroughBlocks.stepIndex, input.step_index),
          ),
        )
        .get();
      if (conflict) {
        result = fail(
          `Error: a block already exists at semantic_step_index=${input.semantic_step_index}, step_index=${input.step_index}. Use update_block to modify it, or pick a different step_index.`,
        );
        return;
      }
      stepIndex = input.step_index;
    } else {
      const maxRow = ctx.db
        .select({ max: sql<number | null>`max(${walkthroughBlocks.stepIndex})` })
        .from(walkthroughBlocks)
        .where(
          and(
            eq(walkthroughBlocks.walkthroughId, walkthroughId),
            eq(walkthroughBlocks.phase, "diff_analysis"),
            eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
          ),
        )
        .get();
      const max = maxRow?.max ?? null;
      stepIndex = max === null ? 0 : max + 1;
    }

    const blockId = blockIdFor(walkthroughId, input.semantic_step_index, stepIndex);
    const built = buildBlock(blockId, input.semantic_step_index, stepIndex, {
      ...(input.content.markdown != null ? { markdown: input.content.markdown } : {}),
      ...(input.content.code != null ? { code: input.content.code } : {}),
      ...(input.content.diff != null ? { diff: input.content.diff } : {}),
    });
    const now = new Date().toISOString();
    ctx.db
      .insert(walkthroughBlocks)
      .values({
        id: blockId,
        walkthroughId,
        phase: "diff_analysis",
        order: input.semantic_step_index * 10000 + stepIndex,
        semanticStepIndex: input.semantic_step_index,
        stepIndex,
        type: built.type,
        data: built.data,
        createdAt: now,
      })
      .run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);
    emitBlock = built.block;
    resolvedStepIndex = stepIndex;
  });
  if (result) return result;
  if (!emitBlock) return fail("Internal error: add_block did not persist.");

  ctx.emit(walkthroughId, { type: "block", data: emitBlock });
  return ok(`Block added at chapter ${input.semantic_step_index}, step ${resolvedStepIndex}.`);
};

// ── Tool: update_block ──────────────────────────────────────────────────────

export const updateBlockHandler: ChatEditToolHandler<UpdateBlockInput> = async (ctx, input) => {
  if (blockContentVariantCount(input.content) !== 1) {
    return fail("Error: update_block.content requires exactly one of { markdown, code, diff }.");
  }

  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let emitBlock: WalkthroughBlock | null = null;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const existing = ctx.db
      .select({ id: walkthroughBlocks.id })
      .from(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, walkthroughId),
          eq(walkthroughBlocks.phase, "diff_analysis"),
          eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
          eq(walkthroughBlocks.stepIndex, input.step_index),
        ),
      )
      .get();
    if (!existing) {
      result = fail(
        `Error: no block exists at chapter ${input.semantic_step_index}, step ${input.step_index}. Use add_block to insert one.`,
      );
      return;
    }

    const blockId = existing.id;
    const built = buildBlock(blockId, input.semantic_step_index, input.step_index, {
      ...(input.content.markdown != null ? { markdown: input.content.markdown } : {}),
      ...(input.content.code != null ? { code: input.content.code } : {}),
      ...(input.content.diff != null ? { diff: input.content.diff } : {}),
    });
    ctx.db
      .update(walkthroughBlocks)
      .set({ type: built.type, data: built.data })
      .where(eq(walkthroughBlocks.id, blockId))
      .run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);
    emitBlock = built.block;
  });
  if (result) return result;
  if (!emitBlock) return fail("Internal error: update_block did not persist.");

  ctx.emit(walkthroughId, { type: "block", data: emitBlock });
  return ok(`Block at chapter ${input.semantic_step_index}, step ${input.step_index} updated.`);
};

// ── Tool: delete_block ──────────────────────────────────────────────────────

export const deleteBlockHandler: ChatEditToolHandler<DeleteBlockInput> = async (ctx, input) => {
  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let deletedBlock: {
    id: string;
    semanticStepIndex: number;
    stepIndex: number;
  } | null = null;
  const updatedIssueEvents: WalkthroughIssue[] = [];

  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const existing = ctx.db
      .select()
      .from(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, walkthroughId),
          eq(walkthroughBlocks.phase, "diff_analysis"),
          eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
          eq(walkthroughBlocks.stepIndex, input.step_index),
        ),
      )
      .get();
    if (!existing) {
      result = fail(
        `Error: no block exists at chapter ${input.semantic_step_index}, step ${input.step_index}.`,
      );
      return;
    }

    const affected = findIssuesReferencingBlocks(ctx.db, walkthroughId, [existing.id]);
    const submitted = affected.filter((a) => a.row.submittedAt !== null);
    if (submitted.length > 0) {
      const titles = submitted.map((a) => `'${a.row.title}'`).join(", ");
      result = fail(
        `Error: cannot delete block — referenced by ${submitted.length} GitHub-submitted issue(s) (${titles}). Submitted issues are immutable.`,
      );
      return;
    }
    const orphaning = affected.filter(
      (a) =>
        a.survivingBlockIds.length === 0 &&
        (a.row.severity === "warning" || a.row.severity === "critical"),
    );
    if (orphaning.length > 0) {
      const titles = orphaning.map((a) => `'${a.row.title}'`).join(", ");
      result = fail(
        `Error: cannot delete block — it is the only block referenced by ${orphaning.length} warning/critical issue(s) (${titles}). Delete those issues first or move their references via update_issue.`,
      );
      return;
    }

    for (const a of affected) {
      ctx.db
        .update(walkthroughIssues)
        .set({ blockIds: JSON.stringify(a.survivingBlockIds) })
        .where(eq(walkthroughIssues.id, a.row.id))
        .run();
      const updated = {
        ...a.row,
        blockIds: JSON.stringify(a.survivingBlockIds),
      };
      updatedIssueEvents.push(decodeIssue(updated));
    }

    ctx.db.delete(walkthroughBlocks).where(eq(walkthroughBlocks.id, existing.id)).run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);

    deletedBlock = {
      id: existing.id,
      semanticStepIndex: existing.semanticStepIndex,
      stepIndex: existing.stepIndex,
    };
  });
  if (result) return result;
  if (!deletedBlock) return fail("Internal error: delete_block did not commit.");

  for (const issue of updatedIssueEvents) ctx.emit(walkthroughId, { type: "issue", data: issue });
  ctx.emit(walkthroughId, { type: "block:deleted", data: deletedBlock });
  return ok(
    `Block at chapter ${input.semantic_step_index}, step ${input.step_index} deleted (${updatedIssueEvents.length} issue(s) had references scrubbed).`,
  );
};

// ── Tool: update_sentiment ──────────────────────────────────────────────────

export const updateSentimentHandler: ChatEditToolHandler<UpdateSentimentInput> = async (ctx, input) => {
  const markdown = unwrapJsonWrappedString(input.markdown, "markdown");

  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }
    ctx.db
      .update(walkthroughs)
      .set({ sentiment: markdown })
      .where(eq(walkthroughs.id, walkthroughId))
      .run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);
  });
  if (result) return result;

  ctx.emit(walkthroughId, {
    type: "sentiment",
    data: { sentiment: markdown },
  });
  return ok("Sentiment updated.");
};
