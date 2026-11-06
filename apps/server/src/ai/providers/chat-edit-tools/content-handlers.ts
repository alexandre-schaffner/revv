import type { RiskLevel, WalkthroughStreamEvent } from "@revv/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import { semanticStepId } from "../../../services/walkthrough/content";
import { decodePlainText } from "../agent-text";
import { fail } from "../mcp-tool-gateway";
import {
  blockContentError,
  blockVariantCount,
  withArtifactWarnings,
  writeBlock,
} from "../walkthrough-blocks";
import { unwrapJsonWrappedString } from "../walkthrough-tools/helpers";
import { runChatEdit, scrubBlockReferences } from "./helpers";
import type {
  AddBlockInput,
  AddSemanticStepEditInput,
  ChatEditToolHandler,
  DeleteBlockInput,
  DeleteSemanticStepInput,
  UpdateBlockInput,
  UpdateOverviewInput,
  UpdateSemanticStepInput,
  UpdateSentimentInput,
} from "./spec";

function chapterAt(db: Db, walkthroughId: string, semanticStepIndex: number) {
  return db
    .select()
    .from(walkthroughSemanticSteps)
    .where(
      and(
        eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
        eq(walkthroughSemanticSteps.semanticStepIndex, semanticStepIndex),
      ),
    )
    .get();
}

function blockAt(db: Db, walkthroughId: string, semanticStepIndex: number, stepIndex: number) {
  return db
    .select()
    .from(walkthroughBlocks)
    .where(
      and(
        eq(walkthroughBlocks.walkthroughId, walkthroughId),
        eq(walkthroughBlocks.phase, "diff_analysis"),
        eq(walkthroughBlocks.semanticStepIndex, semanticStepIndex),
        eq(walkthroughBlocks.stepIndex, stepIndex),
      ),
    )
    .get();
}

export const updateOverviewHandler: ChatEditToolHandler<UpdateOverviewInput> = async (
  ctx,
  input,
) => {
  const summary = input.summary != null ? unwrapJsonWrappedString(input.summary, "summary") : null;
  const riskLevel = input.risk_level ?? null;
  if (summary === null && riskLevel === null) {
    return fail(
      "Error: update_overview needs at least one of summary or risk_level. Both were omitted.",
    );
  }

  return runChatEdit(ctx, (wt) => {
    ctx.db
      .update(walkthroughs)
      .set({
        ...(summary !== null ? { summary } : {}),
        ...(riskLevel !== null ? { riskLevel } : {}),
      })
      .where(eq(walkthroughs.id, wt.id))
      .run();
    const finalSummary = summary ?? wt.summary;
    const finalRisk = (riskLevel ?? wt.riskLevel) as RiskLevel;
    return {
      message: `Overview updated. risk=${finalRisk}${summary !== null ? ` summary=${JSON.stringify(finalSummary.slice(0, 80))}…` : ""}.`,
      events: [{ type: "summary", data: { summary: finalSummary, riskLevel: finalRisk } }],
    };
  });
};

export const addSemanticStepEditHandler: ChatEditToolHandler<AddSemanticStepEditInput> = async (
  ctx,
  input,
) => {
  if (blockVariantCount(input.initial_block) !== 1) {
    return fail(
      "Error: add_semantic_step.initial_block requires exactly one of { markdown, code, diff, artifact }.",
    );
  }
  const initialBlockErr = blockContentError(input.initial_block);
  if (initialBlockErr) return fail(initialBlockErr);
  const title = decodePlainText(input.title);
  if (title.length === 0) {
    return fail("Error: add_semantic_step requires a non-empty title.");
  }

  return runChatEdit(ctx, (wt) => {
    if (chapterAt(ctx.db, wt.id, input.semantic_step_index)) {
      return {
        refused: `Error: a chapter already exists at semantic_step_index=${input.semantic_step_index}. Use update_semantic_step to modify it.`,
      };
    }
    const block = writeBlock(ctx.db, wt.id, input.semantic_step_index, 0, input.initial_block);
    if (!block) {
      return { refused: "Internal error: add_semantic_step built an empty initial block." };
    }
    const chapter = {
      semanticStepIndex: input.semantic_step_index,
      title,
      summary: input.summary ?? null,
    };
    ctx.db
      .insert(walkthroughSemanticSteps)
      .values({
        id: semanticStepId(wt.id, input.semantic_step_index),
        walkthroughId: wt.id,
        ...chapter,
        createdAt: new Date().toISOString(),
      })
      .run();
    return {
      message: withArtifactWarnings(
        `Chapter ${input.semantic_step_index} ('${title}') inserted with its first block.`,
        input.initial_block,
      ),
      events: [
        { type: "semantic-step", data: chapter },
        { type: "block", data: block },
      ],
    };
  });
};

export const updateSemanticStepHandler: ChatEditToolHandler<UpdateSemanticStepInput> = async (
  ctx,
  input,
) => {
  const hasTitle = typeof input.title === "string" && input.title.length > 0;
  const hasSummary = "summary" in input && input.summary !== undefined;
  if (!hasTitle && !hasSummary) {
    return fail("Error: update_semantic_step needs at least one of title or summary.");
  }

  return runChatEdit(ctx, (wt) => {
    const existing = chapterAt(ctx.db, wt.id, input.semantic_step_index);
    if (!existing) {
      return {
        refused: `Error: no chapter exists at semantic_step_index=${input.semantic_step_index}.`,
      };
    }
    const title = hasTitle ? decodePlainText(input.title as string) : existing.title;
    if (title.length === 0) return { refused: "Error: title cannot be empty." };
    const summary = hasSummary ? (input.summary ?? null) : existing.summary;
    ctx.db
      .update(walkthroughSemanticSteps)
      .set({ title, summary })
      .where(eq(walkthroughSemanticSteps.id, existing.id))
      .run();
    return {
      message: `Chapter ${input.semantic_step_index} updated.`,
      events: [
        {
          type: "semantic-step",
          data: { semanticStepIndex: input.semantic_step_index, title, summary },
        },
      ],
    };
  });
};

export const deleteSemanticStepHandler: ChatEditToolHandler<DeleteSemanticStepInput> = async (
  ctx,
  input,
) =>
  runChatEdit(ctx, (wt) => {
    const chapter = chapterAt(ctx.db, wt.id, input.semantic_step_index);
    if (!chapter) {
      return {
        refused: `Error: no chapter exists at semantic_step_index=${input.semantic_step_index}.`,
      };
    }
    const inChapter = and(
      eq(walkthroughBlocks.walkthroughId, wt.id),
      eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
    );
    const blocks = ctx.db.select().from(walkthroughBlocks).where(inChapter).all();
    const scrubbed = scrubBlockReferences(
      ctx.db,
      wt.id,
      blocks.map((b) => b.id),
      "chapter",
    );
    if ("refused" in scrubbed) return scrubbed;

    ctx.db.delete(walkthroughBlocks).where(inChapter).run();
    ctx.db
      .delete(walkthroughSemanticSteps)
      .where(eq(walkthroughSemanticSteps.id, chapter.id))
      .run();

    const events: WalkthroughStreamEvent[] = [
      ...blocks.map(
        (b): WalkthroughStreamEvent => ({
          type: "block:deleted",
          data: { id: b.id, semanticStepIndex: b.semanticStepIndex, stepIndex: b.stepIndex },
        }),
      ),
      ...scrubbed.issues.map((issue): WalkthroughStreamEvent => ({ type: "issue", data: issue })),
      { type: "semantic-step:deleted", data: { semanticStepIndex: input.semantic_step_index } },
    ];
    return {
      message: `Chapter ${input.semantic_step_index} deleted (${blocks.length} block(s); ${scrubbed.issues.length} issue(s) had references scrubbed).`,
      events,
    };
  });

export const addBlockHandler: ChatEditToolHandler<AddBlockInput> = async (ctx, input) => {
  if (blockVariantCount(input.content) !== 1) {
    return fail(
      "Error: add_block.content requires exactly one of { markdown, code, diff, artifact }.",
    );
  }
  const contentErr = blockContentError(input.content);
  if (contentErr) return fail(contentErr);

  return runChatEdit(ctx, (wt) => {
    if (!chapterAt(ctx.db, wt.id, input.semantic_step_index)) {
      return {
        refused: `Error: no chapter exists at semantic_step_index=${input.semantic_step_index}. Call add_semantic_step first.`,
      };
    }

    let stepIndex: number;
    if (input.step_index != null) {
      if (blockAt(ctx.db, wt.id, input.semantic_step_index, input.step_index)) {
        return {
          refused: `Error: a block already exists at semantic_step_index=${input.semantic_step_index}, step_index=${input.step_index}. Use update_block to modify it, or pick a different step_index.`,
        };
      }
      stepIndex = input.step_index;
    } else {
      const max =
        ctx.db
          .select({ max: sql<number | null>`max(${walkthroughBlocks.stepIndex})` })
          .from(walkthroughBlocks)
          .where(
            and(
              eq(walkthroughBlocks.walkthroughId, wt.id),
              eq(walkthroughBlocks.phase, "diff_analysis"),
              eq(walkthroughBlocks.semanticStepIndex, input.semantic_step_index),
            ),
          )
          .get()?.max ?? null;
      stepIndex = max === null ? 0 : max + 1;
    }

    const block = writeBlock(ctx.db, wt.id, input.semantic_step_index, stepIndex, input.content);
    if (!block) return { refused: "Internal error: add_block built an empty block." };
    return {
      message: withArtifactWarnings(
        `Block added at chapter ${input.semantic_step_index}, step ${stepIndex}.`,
        input.content,
      ),
      events: [{ type: "block", data: block }],
    };
  });
};

export const updateBlockHandler: ChatEditToolHandler<UpdateBlockInput> = async (ctx, input) => {
  if (blockVariantCount(input.content) !== 1) {
    return fail(
      "Error: update_block.content requires exactly one of { markdown, code, diff, artifact }.",
    );
  }
  const contentErr = blockContentError(input.content);
  if (contentErr) return fail(contentErr);

  return runChatEdit(ctx, (wt) => {
    if (!blockAt(ctx.db, wt.id, input.semantic_step_index, input.step_index)) {
      return {
        refused: `Error: no block exists at chapter ${input.semantic_step_index}, step ${input.step_index}. Use add_block to insert one.`,
      };
    }
    const block = writeBlock(
      ctx.db,
      wt.id,
      input.semantic_step_index,
      input.step_index,
      input.content,
    );
    if (!block) return { refused: "Internal error: update_block built an empty block." };
    return {
      message: withArtifactWarnings(
        `Block at chapter ${input.semantic_step_index}, step ${input.step_index} updated.`,
        input.content,
      ),
      events: [{ type: "block", data: block }],
    };
  });
};

export const deleteBlockHandler: ChatEditToolHandler<DeleteBlockInput> = async (ctx, input) =>
  runChatEdit(ctx, (wt) => {
    const existing = blockAt(ctx.db, wt.id, input.semantic_step_index, input.step_index);
    if (!existing) {
      return {
        refused: `Error: no block exists at chapter ${input.semantic_step_index}, step ${input.step_index}.`,
      };
    }
    const scrubbed = scrubBlockReferences(ctx.db, wt.id, [existing.id], "block");
    if ("refused" in scrubbed) return scrubbed;
    ctx.db.delete(walkthroughBlocks).where(eq(walkthroughBlocks.id, existing.id)).run();
    return {
      message: `Block at chapter ${input.semantic_step_index}, step ${input.step_index} deleted (${scrubbed.issues.length} issue(s) had references scrubbed).`,
      events: [
        ...scrubbed.issues.map((issue): WalkthroughStreamEvent => ({ type: "issue", data: issue })),
        {
          type: "block:deleted",
          data: {
            id: existing.id,
            semanticStepIndex: existing.semanticStepIndex,
            stepIndex: existing.stepIndex,
          },
        },
      ],
    };
  });

export const updateSentimentHandler: ChatEditToolHandler<UpdateSentimentInput> = async (
  ctx,
  input,
) => {
  const markdown = unwrapJsonWrappedString(input.markdown, "markdown");
  return runChatEdit(ctx, (wt) => {
    ctx.db
      .update(walkthroughs)
      .set({ sentiment: markdown })
      .where(eq(walkthroughs.id, wt.id))
      .run();
    return {
      message: "Sentiment updated.",
      events: [{ type: "sentiment", data: { sentiment: markdown } }],
    };
  });
};
