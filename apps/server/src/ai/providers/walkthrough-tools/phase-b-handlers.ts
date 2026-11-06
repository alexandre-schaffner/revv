// ─── walkthrough-phase-b-handlers ────────────────────────────────────────────
//
// Phase B: chapters, blocks, issues and their inline comments.

import type {
  CommentThread,
  ThreadMessage,
  WalkthroughBlock,
  WalkthroughIssue,
  WalkthroughSemanticStep,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import {
  decodeIssue,
  issueId as deriveIssueId,
  isSameResolvedFinding,
  renderUnknownBlockRefs,
  resolveBlockRefs,
  semanticStepId,
  upsertIssueComment,
} from "../../../services/walkthrough/content";
import { renderArtifactRejection } from "../../jev/artifact-quality";
import { decodePlainText } from "../agent-text";
import { fail, ok } from "../mcp-tool-gateway";
import {
  blockContentError,
  blockVariantCount,
  withArtifactWarnings,
  writeBlock,
} from "../walkthrough-blocks";
import { openForWrite } from "./phases";
import type {
  AddDiffStepInput,
  AddIssueCommentInput,
  AddSemanticStepInput,
  FlagIssueInput,
  WalkthroughToolHandler,
  WalkthroughToolResult,
} from "./spec";

// ── Handler: add_semantic_step (Phase B chapter declaration) ─────────────────
//
// Writes the chapter and its step_index=0 block in one transaction: models
// that stopped between opening a chapter and filling it left empty chapters
// the completion gate rejected. The first call owns the A → B transition.

export const addSemanticStepHandler: WalkthroughToolHandler<AddSemanticStepInput> = async (
  ctx,
  input,
) => {
  const trimmedTitle = decodePlainText(input.title);
  if (trimmedTitle.length === 0) {
    return fail(
      "Error: add_semantic_step requires a non-empty title — chapters are named, not anonymous.",
    );
  }

  if (blockVariantCount(input.initial_block) !== 1) {
    return fail(
      "Error: add_semantic_step.initial_block requires exactly one of { markdown, code, diff, artifact } — not zero, not two. A chapter cannot be opened without its first block.",
    );
  }
  const initialBlockErr = blockContentError(input.initial_block);
  if (initialBlockErr) return fail(initialBlockErr);

  // Same craft bar as add_diff_step; rejecting here also rejects the
  // chapter, since a chapter can't exist without its first block.
  if (input.initial_block.artifact) {
    const verdict = await ctx.jev.judgeArtifact(input.initial_block.artifact.html, {
      chapterTitle: trimmedTitle,
      annotation: input.initial_block.artifact.annotation,
    });
    if (verdict.reject) return fail(renderArtifactRejection(verdict));
  }

  let result: WalkthroughToolResult | null = null;
  let isFirstStep = false;
  let block: WalkthroughBlock | null = null;
  const semanticStep: WalkthroughSemanticStep = {
    semanticStepIndex: input.semantic_step_index,
    title: trimmedTitle,
    summary: input.summary ?? null,
  };
  ctx.db.transaction(() => {
    const open = openForWrite(ctx.db, ctx.walkthroughId, "add_semantic_step");
    if ("refusal" in open) {
      result = open.refusal;
      return;
    }
    const { phase } = open;

    // Sequencing: a NEW chapter (no existing row at this index) may only be
    // opened if the immediately previous chapter exists. Retries of an
    // existing chapter (update path) bypass this check. The atomic
    // open+first-block design means "previous chapter has a block" is
    // implied by "previous chapter exists" — no separate fill check needed.
    const existingChapter = ctx.db
      .select({ id: walkthroughSemanticSteps.id })
      .from(walkthroughSemanticSteps)
      .where(
        and(
          eq(walkthroughSemanticSteps.walkthroughId, ctx.walkthroughId),
          eq(walkthroughSemanticSteps.semanticStepIndex, input.semantic_step_index),
        ),
      )
      .get();
    if (!existingChapter && input.semantic_step_index > 0) {
      const prevIdx = input.semantic_step_index - 1;
      const prevChapter = ctx.db
        .select({ title: walkthroughSemanticSteps.title })
        .from(walkthroughSemanticSteps)
        .where(
          and(
            eq(walkthroughSemanticSteps.walkthroughId, ctx.walkthroughId),
            eq(walkthroughSemanticSteps.semanticStepIndex, prevIdx),
          ),
        )
        .get();
      if (!prevChapter) {
        result = fail(
          `Error: semantic_step_index must be sequential and start at 0. Index ${prevIdx} does not exist yet — open chapter ${prevIdx} first with add_semantic_step({ semantic_step_index: ${prevIdx}, ... }), then open ${input.semantic_step_index}.`,
        );
        return;
      }
    }

    ctx.db
      .insert(walkthroughSemanticSteps)
      .values({
        id: semanticStepId(ctx.walkthroughId, input.semantic_step_index),
        walkthroughId: ctx.walkthroughId,
        semanticStepIndex: input.semantic_step_index,
        title: trimmedTitle,
        summary: input.summary ?? null,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [
          walkthroughSemanticSteps.walkthroughId,
          walkthroughSemanticSteps.semanticStepIndex,
        ],
        set: {
          title: trimmedTitle,
          summary: input.summary ?? null,
        },
      })
      .run();

    block = writeBlock(
      ctx.db,
      ctx.walkthroughId,
      input.semantic_step_index,
      0,
      input.initial_block,
    );

    if (phase === "A") {
      isFirstStep = true;
      ctx.db
        .update(walkthroughs)
        .set({ lastCompletedPhase: "B" })
        .where(eq(walkthroughs.id, ctx.walkthroughId))
        .run();
    }
  });
  if (result) return result;
  if (!block) {
    return fail(
      "Internal error: add_semantic_step reached emit without a persisted initial block.",
    );
  }

  ctx.emit({ type: "semantic-step", data: semanticStep });
  ctx.emit({ type: "block", data: block });
  if (isFirstStep) {
    ctx.emit({
      type: "phase:advanced",
      data: { lastCompletedPhase: "B" },
    });
  }
  if (input.initial_block.markdown) {
    ctx.jev.scheduleProseCheck(input.initial_block.markdown.content, trimmedTitle);
  }
  return ok(
    withArtifactWarnings(
      `Chapter ${input.semantic_step_index} ('${trimmedTitle}') opened with its first block at step_index=0. Add 1–4 more atomic blocks for this chapter via add_diff_step({ semantic_step_index: ${input.semantic_step_index}, step_index: 1, ... }) — step_index 2, 3, 4 for the rest. When this chapter is full, open the next chapter via another add_semantic_step call. Do not call set_sentiment until every planned chapter is filled.`,
      input.initial_block,
    ),
  );
};

// ── Handler: add_diff_step (Phase B) ─────────────────────────────────────────

export const addDiffStepHandler: WalkthroughToolHandler<AddDiffStepInput> = async (ctx, input) => {
  // Exactly one of {markdown, code, diff, artifact} must be provided.
  if (blockVariantCount(input) !== 1) {
    return fail(
      "Error: add_diff_step requires exactly one of { markdown, code, diff, artifact } — not zero, not two. Pick the shape that matches the step's intent.",
    );
  }
  const contentErr = blockContentError(input);
  if (contentErr) return fail(contentErr);
  const variant = {
    markdown: input.markdown,
    code: input.code,
    diff: input.diff,
    artifact: input.artifact,
  };

  // Craft bar runs before the write: rejecting after would leave a hole in
  // step_index, and there's no cheap way to undo a block already read.
  const chapterTitle = chapterTitleFor(ctx.db, ctx.walkthroughId, input.semantic_step_index);
  if (input.artifact) {
    const verdict = await ctx.jev.judgeArtifact(input.artifact.html, {
      chapterTitle,
      annotation: input.artifact.annotation,
    });
    if (verdict.reject) return fail(renderArtifactRejection(verdict));
  }

  let result: WalkthroughToolResult | null = null;
  let block: WalkthroughBlock | null = null;
  ctx.db.transaction(() => {
    const open = openForWrite(ctx.db, ctx.walkthroughId, "add_diff_step");
    if ("refusal" in open) {
      result = open.refusal;
      return;
    }

    const parent = ctx.db
      .select({ id: walkthroughSemanticSteps.id })
      .from(walkthroughSemanticSteps)
      .where(
        and(
          eq(walkthroughSemanticSteps.walkthroughId, ctx.walkthroughId),
          eq(walkthroughSemanticSteps.semanticStepIndex, input.semantic_step_index),
        ),
      )
      .get();
    if (!parent) {
      result = fail(
        `Error: no semantic_step exists at semantic_step_index=${input.semantic_step_index}. Call add_semantic_step first with that index, then retry this add_diff_step.`,
      );
      return;
    }

    block = writeBlock(
      ctx.db,
      ctx.walkthroughId,
      input.semantic_step_index,
      input.step_index,
      variant,
    );
  });
  if (result) return result;
  if (!block) {
    return fail("Internal error: add_diff_step reached emit without a block variant.");
  }

  ctx.emit({ type: "block", data: block });
  if (input.markdown) {
    ctx.jev.scheduleProseCheck(input.markdown.content, chapterTitle);
  }
  // Voice advice from an earlier block, if it landed by now; rides out on
  // this call rather than blocking the block it's about. See ai/jev/prose-voice.ts.
  const advice = ctx.jev.takeProseAdvice() ?? "";
  return ok(
    withArtifactWarnings(
      `Atomic block persisted at chapter ${input.semantic_step_index}, step ${input.step_index}. Continue with more blocks in this chapter, open the next chapter with add_semantic_step, or call set_sentiment when Phase B is done.${advice}`,
      variant,
    ),
  );
};

/** Chapter title for context, or a placeholder when the chapter is brand new. */
function chapterTitleFor(db: Db, walkthroughId: string, semanticStepIndex: number): string {
  return (
    db
      .select({ title: walkthroughSemanticSteps.title })
      .from(walkthroughSemanticSteps)
      .where(
        and(
          eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
          eq(walkthroughSemanticSteps.semanticStepIndex, semanticStepIndex),
        ),
      )
      .get()?.title ?? "(chapter being opened)"
  );
}

// ── Handler: flag_issue (during Phase B) ─────────────────────────────────────
//
// The row writes unconditionally; a Jev judgment scheduled behind it
// (ai/jev/issue-relevance.ts) may retract or relabel it later. Scheduled, not
// awaited — blocking would cost each concern a round trip. The completion
// gate and add_issue_comment get consistency from ai/jev/pending.ts instead.

function checkFlagIssuePreconditions(
  db: Db,
  walkthroughId: string,
  input: FlagIssueInput,
):
  | { readonly ok: true; readonly blockIds: string[]; readonly parentWalkthroughId: string | null }
  | { readonly ok: false; readonly error: WalkthroughToolResult } {
  const open = openForWrite(db, walkthroughId, "flag_issue");
  if ("refusal" in open) return { ok: false, error: open.refusal };
  const refs = resolveBlockRefs(db, walkthroughId, input.block_refs);
  if ("unknown" in refs) {
    return {
      ok: false,
      error: fail(
        `${renderUnknownBlockRefs(refs.unknown)} Call add_diff_step for each before flag_issue.`,
      ),
    };
  }
  return { ok: true, blockIds: refs.blockIds, parentWalkthroughId: open.row.parentWalkthroughId };
}

export const flagIssueHandler: WalkthroughToolHandler<FlagIssueInput> = async (ctx, input) => {
  // Normalize before hashing: the id is derived from the title, so decoding
  // afterwards would give the same concern two different ids across runs.
  const title = decodePlainText(input.title);
  const description = decodePlainText(input.description);
  const issueId = deriveIssueId(
    ctx.walkthroughId,
    title,
    input.file_path ?? null,
    input.start_line ?? null,
  );

  let result: WalkthroughToolResult | null = null;
  let issueEvent: WalkthroughIssue | null = null;
  ctx.db.transaction(() => {
    const guard = checkFlagIssuePreconditions(ctx.db, ctx.walkthroughId, input);
    if (!guard.ok) {
      result = guard.error;
      return;
    }
    const blockIds = guard.blockIds;

    // Issue `order` is the post-row insertion order within this walkthrough —
    // compute it inside the transaction so concurrent writes (which can't
    // happen today, but defended anyway) don't collide.
    const existing = ctx.db
      .select({ id: walkthroughIssues.id, order: walkthroughIssues.order })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, ctx.walkthroughId))
      .all();
    const order = existing.find((e) => e.id === issueId)?.order ?? existing.length;

    // A new head produces a new immutable walkthrough row. Preserve a local
    // resolution only when the regenerated concern is byte-for-byte the same
    // finding at the same location; changed findings deliberately reopen.
    const { parentWalkthroughId } = guard;
    const priorResolution = parentWalkthroughId
      ? ctx.db
          .select()
          .from(walkthroughIssues)
          .where(eq(walkthroughIssues.walkthroughId, parentWalkthroughId))
          .all()
          .find((issue) =>
            isSameResolvedFinding(issue, {
              severity: input.severity,
              title,
              description,
              filePath: input.file_path ?? null,
              startLine: input.start_line ?? null,
              endLine: input.end_line ?? null,
            }),
          )
      : undefined;

    const now = new Date().toISOString();
    ctx.db
      .insert(walkthroughIssues)
      .values({
        id: issueId,
        walkthroughId: ctx.walkthroughId,
        order,
        severity: input.severity,
        title,
        description,
        filePath: input.file_path ?? null,
        startLine: input.start_line ?? null,
        endLine: input.end_line ?? null,
        blockIds: JSON.stringify(blockIds),
        createdAt: now,
        ...(priorResolution
          ? {
              resolutionStatus: priorResolution.resolutionStatus,
              resolutionExplanation: priorResolution.resolutionExplanation,
              resolutionEvidence: priorResolution.resolutionEvidence,
              resolvingCommitSha: priorResolution.resolvingCommitSha,
              resolvedAt: priorResolution.resolvedAt,
              resolvedBy: priorResolution.resolvedBy,
            }
          : {}),
      })
      .onConflictDoUpdate({
        target: walkthroughIssues.id,
        set: {
          severity: input.severity,
          title,
          description,
          filePath: input.file_path ?? null,
          startLine: input.start_line ?? null,
          endLine: input.end_line ?? null,
          blockIds: JSON.stringify(blockIds),
          // Clear the score on re-flag: a stale verdict shouldn't stick to
          // revised wording.
          advisoryScore: null,
          advisoryScoredAt: null,
        },
      })
      .run();

    const persisted = ctx.db
      .select()
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.id, issueId))
      .get();
    if (persisted) issueEvent = decodeIssue(persisted);
  });
  if (result) return result;
  if (issueEvent) {
    ctx.emit({ type: "issue", data: issueEvent });
  }

  // Fire-and-forget: the row is already durable; the judgment can only
  // remove or relabel it.
  ctx.jev.scheduleIssueJudgment(issueId, {
    severity: input.severity,
    title,
    description,
    filePath: input.file_path ?? null,
    startLine: input.start_line ?? null,
    endLine: input.end_line ?? null,
  });

  // Can't branch on agent-sent severity — it's provisional until the
  // judgment lands — so every anchored concern gets a required inline
  // comment. A redundant comment is cheap; a missing one bounces the run.
  const hasLineAnchor = input.file_path !== null && input.start_line !== null;
  const nextStepHint = hasLineAnchor
    ? `\n\nNEXT STEP — REQUIRED: call add_issue_comment with issue_id="${issueId}", file_path="${input.file_path}", start_line=${input.start_line}, end_line=${input.end_line ?? input.start_line}, and a body that explains the concern to the coder (2–6 sentences, markdown, second-person voice). Without that follow-up call this issue has no inline comment in the diff. If the concern affects multiple call-sites, call add_issue_comment once per line range with the same issue_id.`
    : `\n\n(PR-wide concern with no line anchor — no inline comment needed. Continue with the next concern or diff step.)`;
  return ok(`Issue flagged: ${title} (id: ${issueId}).${nextStepHint}`);
};

// ── Handler: add_issue_comment (Phase B) ─────────────────────────────────────
//
// One thread per anchor, keyed deterministically, so a retry replaces the body
// instead of stacking threads. The thread joins the walkthrough's review
// session, where the diff view picks it up.

export const addIssueCommentHandler: WalkthroughToolHandler<AddIssueCommentInput> = async (
  ctx,
  input,
) => {
  if (input.end_line < input.start_line) {
    return fail(
      `Error: end_line (${input.end_line}) is before start_line (${input.start_line}). Use end_line === start_line for a single-line comment.`,
    );
  }

  const outcome = ctx.db.transaction(
    ():
      | { readonly result: WalkthroughToolResult }
      | {
          readonly prId: string;
          readonly thread: CommentThread;
          readonly message: ThreadMessage;
        } => {
      const open = openForWrite(ctx.db, ctx.walkthroughId, "add_issue_comment");
      if ("refusal" in open) return { result: open.refusal };

      const issueRow = ctx.db
        .select({ id: walkthroughIssues.id })
        .from(walkthroughIssues)
        .where(
          and(
            eq(walkthroughIssues.id, input.issue_id),
            eq(walkthroughIssues.walkthroughId, ctx.walkthroughId),
          ),
        )
        .get();
      if (!issueRow) {
        // Retracted by the relevance judgment behind flag_issue — not the
        // agent's mistake. isError here would send it hunting a bug that isn't there.
        if (ctx.jev.issueRetracted(input.issue_id)) {
          return {
            result: ok(
              `That concern was withdrawn after you flagged it — the relevance check judged it below the bar for this pull request, so there is nothing left to comment on. This is not an error and not something to retry. Move on to the next concern or diff step.`,
            ),
          };
        }
        return {
          result: fail(
            `Error: issue_id '${input.issue_id}' does not match any flagged issue for this walkthrough. Call flag_issue first; the result text contains the issue id you must pass back here.`,
          ),
        };
      }

      return {
        prId: open.row.pullRequestId,
        ...upsertIssueComment(ctx.db, {
          walkthroughId: ctx.walkthroughId,
          reviewSessionId: open.row.reviewSessionId,
          issueId: input.issue_id,
          filePath: input.file_path,
          startLine: input.start_line,
          endLine: input.end_line,
          diffSide: input.diff_side,
          body: input.body,
        }),
      };
    },
  );
  if ("result" in outcome) return outcome.result;
  const { prId, thread, message } = outcome;

  // The diff view dedupes by thread id, so a replayed upsert is harmless.
  ctx.broadcastThreadEvent({
    type: "thread:created",
    data: { prId, thread, message },
  });

  return ok(
    `Comment posted on ${input.file_path}:${input.start_line}${
      input.end_line !== input.start_line ? `-${input.end_line}` : ""
    } (${input.diff_side} side) for issue ${input.issue_id}. Thread id: ${thread.id}.`,
  );
};
