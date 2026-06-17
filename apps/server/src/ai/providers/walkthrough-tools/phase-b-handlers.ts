// ─── walkthrough-phase-b-handlers ────────────────────────────────────────────
//
// Phase B MCP tool handlers: add_semantic_step, add_diff_step, flag_issue,
// and add_issue_comment. These are the bulk of the walkthrough pipeline and
// handle chapter declaration, block persistence, issue flagging, and inline
// comment creation.

import type {
  CommentThread,
  ThreadMessage,
  WalkthroughBlock,
  WalkthroughIssue,
  WalkthroughPipelinePhase,
  WalkthroughSemanticStep,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db";
import { commentThreads } from "../../../db/schema/comment-threads";
import { threadMessages } from "../../../db/schema/thread-messages";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import {
  type BlockVariantInput,
  blockRow,
  blockVariantCount,
  buildBlock,
  emptyBlockError,
  withArtifactThemingWarning,
} from "../walkthrough-blocks";
import {
  blockIdFor,
  errorResult,
  loadWalkthroughRow,
  okResult,
  phaseAtLeast,
  phaseAtMost,
} from "./helpers";
import {
  type AddDiffStepInput,
  type AddIssueCommentInput,
  type AddSemanticStepInput,
  computeAnchorThreadId,
  computeIssueId,
  type FlagIssueInput,
  type WalkthroughToolHandler,
  type WalkthroughToolResult,
} from "./spec";

// ── Block persistence helper ─────────────────────────────────────────────────
//
// Shared by addSemanticStepHandler (step_index=0 initial block) and
// addDiffStepHandler (subsequent blocks). The typed-block construction and
// variant validation live in `../walkthrough-blocks` so the generation path
// and the chat-edit path stay byte-for-byte identical (CLAUDE.md #2, #13).
// This wrapper adds only the generation-path concern: the idempotent upsert
// into `walkthrough_blocks` on the composite key.

/**
 * Build a typed WalkthroughBlock from one of the four variant inputs (via the
 * shared {@link buildBlock}) and upsert it into walkthroughBlocks. Returns the
 * constructed block, or null if no variant was provided (caller must validate
 * beforehand with {@link blockVariantCount}).
 */
function persistBlockVariant(
  db: Db,
  opts: {
    readonly walkthroughId: string;
    readonly blockId: string;
    readonly semanticStepIndex: number;
    readonly stepIndex: number;
    readonly order: number;
    readonly createdAt: string;
  },
  variant: BlockVariantInput,
): WalkthroughBlock | null {
  const { walkthroughId, blockId, semanticStepIndex, stepIndex, order, createdAt } = opts;

  const block = buildBlock(blockId, semanticStepIndex, stepIndex, variant);
  if (!block) return null;
  const { type, data } = blockRow(block);

  db.insert(walkthroughBlocks)
    .values({
      id: blockId,
      walkthroughId,
      phase: "diff_analysis",
      order,
      semanticStepIndex,
      stepIndex,
      type,
      data,
      createdAt,
    })
    .onConflictDoUpdate({
      target: [
        walkthroughBlocks.walkthroughId,
        walkthroughBlocks.phase,
        walkthroughBlocks.semanticStepIndex,
        walkthroughBlocks.stepIndex,
      ],
      set: { type, data },
    })
    .run();

  return block;
}

// ── Handler: add_semantic_step (Phase B chapter declaration) ─────────────────
//
// Phase precondition: last_completed_phase ∈ {'A', 'B'}.
// Writes: one walkthrough_semantic_steps row (upsert on (walkthroughId,
// semanticStepIndex)) AND one walkthrough_blocks row at step_index=0 (upsert
// on (walkthroughId, phase, semanticStepIndex, stepIndex)) — both in a single
// transaction. The atomic open+first-block design eliminates the "opened but
// empty chapter" failure mode by construction: models that stopped between
// the old `add_semantic_step` and the first `add_diff_step` call now write
// both rows from a single tool invocation, so a chapter literally cannot
// exist without content.
//
// Owns the Phase A → B transition: the first call advances
// last_completed_phase to 'B' in the same transaction so subsequent
// add_diff_step calls accept their writes.

export const addSemanticStepHandler: WalkthroughToolHandler<AddSemanticStepInput> = async (
  ctx,
  input,
) => {
  const trimmedTitle = input.title.trim();
  if (trimmedTitle.length === 0) {
    return errorResult(
      "Error: add_semantic_step requires a non-empty title — chapters are named, not anonymous.",
    );
  }

  if (blockVariantCount(input.initial_block) !== 1) {
    return errorResult(
      "Error: add_semantic_step.initial_block requires exactly one of { markdown, code, diff, artifact } — not zero, not two. A chapter cannot be opened without its first block.",
    );
  }
  const initialBlockErr = emptyBlockError(input.initial_block);
  if (initialBlockErr) return errorResult(initialBlockErr);

  let result: WalkthroughToolResult | null = null;
  let isFirstStep = false;
  let block: WalkthroughBlock | null = null;
  const semanticStep: WalkthroughSemanticStep = {
    semanticStepIndex: input.semantic_step_index,
    title: trimmedTitle,
    summary: input.summary ?? null,
  };
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (!phaseAtLeast(phase, "A") || !phaseAtMost(phase, "B")) {
      result = errorResult(
        `Error: add_semantic_step requires Phase A complete and Phase C not yet entered. Current phase: '${phase}'. Call set_overview first, or stop adding chapters once sentiment has been set.`,
      );
      return;
    }

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
        result = errorResult(
          `Error: semantic_step_index must be sequential and start at 0. Index ${prevIdx} does not exist yet — open chapter ${prevIdx} first with add_semantic_step({ semantic_step_index: ${prevIdx}, ... }), then open ${input.semantic_step_index}.`,
        );
        return;
      }
    }

    const id = `semantic-${ctx.walkthroughId}-${input.semantic_step_index}`;
    const now = new Date().toISOString();
    ctx.db
      .insert(walkthroughSemanticSteps)
      .values({
        id,
        walkthroughId: ctx.walkthroughId,
        semanticStepIndex: input.semantic_step_index,
        title: trimmedTitle,
        summary: input.summary ?? null,
        createdAt: now,
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

    // Atomically write the chapter's step_index=0 block from the same
    // transaction so the chapter is never persisted without content.
    const blockId = blockIdFor(ctx.walkthroughId, input.semantic_step_index, 0);
    const order = input.semantic_step_index * 10000;
    block = persistBlockVariant(
      ctx.db,
      {
        walkthroughId: ctx.walkthroughId,
        blockId,
        semanticStepIndex: input.semantic_step_index,
        stepIndex: 0,
        order,
        createdAt: now,
      },
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
    return errorResult(
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
  return okResult(
    withArtifactThemingWarning(
      `Chapter ${input.semantic_step_index} ('${trimmedTitle}') opened with its first block at step_index=0. Add 1–4 more atomic blocks for this chapter via add_diff_step({ semantic_step_index: ${input.semantic_step_index}, step_index: 1, ... }) — step_index 2, 3, 4 for the rest. When this chapter is full, open the next chapter via another add_semantic_step call. Do not call set_sentiment until every planned chapter is filled.`,
      input.initial_block,
    ),
  );
};

// ── Handler: add_diff_step (Phase B) ─────────────────────────────────────────
//
// Phase precondition: last_completed_phase === 'B' (a parent semantic step
// must already exist — `add_semantic_step` owns the A→B transition).
// Writes: one walkthrough_blocks row (upsert on (walkthroughId, phase,
// semanticStepIndex, stepIndex)).

export const addDiffStepHandler: WalkthroughToolHandler<AddDiffStepInput> = async (ctx, input) => {
  // Exactly one of {markdown, code, diff, artifact} must be provided.
  if (blockVariantCount(input) !== 1) {
    return errorResult(
      "Error: add_diff_step requires exactly one of { markdown, code, diff, artifact } — not zero, not two. Pick the shape that matches the step's intent.",
    );
  }
  const emptyErr = emptyBlockError(input);
  if (emptyErr) return errorResult(emptyErr);
  const variant = {
    markdown: input.markdown,
    code: input.code,
    diff: input.diff,
    artifact: input.artifact,
  };

  let result: WalkthroughToolResult | null = null;
  let block: WalkthroughBlock | null = null;
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (phase !== "B") {
      result = errorResult(
        `Error: add_diff_step requires Phase B (open via add_semantic_step) and Phase C not yet entered. Current phase: '${phase}'. ${phase === "A" ? "Call add_semantic_step first to open the first chapter — it advances the pipeline to Phase B and creates the parent row this block attaches to." : "Stop adding diff steps once sentiment has been set."}`,
      );
      return;
    }

    // Parent semantic step must exist for the composite key to be valid.
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
      result = errorResult(
        `Error: no semantic_step exists at semantic_step_index=${input.semantic_step_index}. Call add_semantic_step first with that index, then retry this add_diff_step.`,
      );
      return;
    }

    const blockId = blockIdFor(ctx.walkthroughId, input.semantic_step_index, input.step_index);
    const now = new Date().toISOString();

    block = persistBlockVariant(
      ctx.db,
      {
        walkthroughId: ctx.walkthroughId,
        blockId,
        semanticStepIndex: input.semantic_step_index,
        stepIndex: input.step_index,
        order: input.semantic_step_index * 10000 + input.step_index,
        createdAt: now,
      },
      variant,
    );
  });
  if (result) return result;
  if (!block) {
    return errorResult("Internal error: add_diff_step reached emit without a block variant.");
  }

  ctx.emit({ type: "block", data: block });
  return okResult(
    withArtifactThemingWarning(
      `Atomic block persisted at chapter ${input.semantic_step_index}, step ${input.step_index}. Continue with more blocks in this chapter, open the next chapter with add_semantic_step, or call set_sentiment when Phase B is done.`,
      variant,
    ),
  );
};

// ── Handler: flag_issue (during Phase B) ─────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'A', 'B'} (issues must link to
// already-persisted diff steps).
// Writes: one walkthrough_issues row (upsert on deterministic id).
// Does not advance phase.

export const flagIssueHandler: WalkthroughToolHandler<FlagIssueInput> = async (ctx, input) => {
  const issueId = await computeIssueId(
    ctx.walkthroughId,
    input.title,
    input.file_path ?? null,
    input.start_line ?? null,
  );

  let result: WalkthroughToolResult | null = null;
  let issueEvent: WalkthroughIssue | null = null;
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (!phaseAtLeast(phase, "A") || !phaseAtMost(phase, "B")) {
      result = errorResult(
        `Error: flag_issue is only valid during Phase A/B. Current phase: '${phase}'.`,
      );
      return;
    }

    // Validate all referenced block_refs point at persisted diff blocks.
    const stepRows = ctx.db
      .select({
        semanticStepIndex: walkthroughBlocks.semanticStepIndex,
        stepIndex: walkthroughBlocks.stepIndex,
      })
      .from(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
          eq(walkthroughBlocks.phase, "diff_analysis"),
        ),
      )
      .all();
    const knownBlocks = new Set(stepRows.map((r) => `${r.semanticStepIndex}:${r.stepIndex}`));
    const unknown = input.block_refs.filter(
      (r) => !knownBlocks.has(`${r.semantic_step_index}:${r.step_index}`),
    );
    if (unknown.length > 0) {
      result = errorResult(
        `Error: block_refs [${unknown.map((r) => `{semantic_step_index: ${r.semantic_step_index}, step_index: ${r.step_index}}`).join(", ")}] reference diff blocks that don't exist yet. Call add_diff_step for each before flag_issue.`,
      );
      return;
    }

    const seen = new Set<string>();
    const uniqueRefs = input.block_refs.filter((r) => {
      const k = `${r.semantic_step_index}:${r.step_index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const blockIds = uniqueRefs.map((r) =>
      blockIdFor(ctx.walkthroughId, r.semantic_step_index, r.step_index),
    );

    // Issue `order` is the post-row insertion order within this walkthrough —
    // compute it inside the transaction so concurrent writes (which can't
    // happen today, but defended anyway) don't collide.
    const existing = ctx.db
      .select({ id: walkthroughIssues.id, order: walkthroughIssues.order })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, ctx.walkthroughId))
      .all();
    const order = existing.find((e) => e.id === issueId)?.order ?? existing.length;

    const now = new Date().toISOString();
    ctx.db
      .insert(walkthroughIssues)
      .values({
        id: issueId,
        walkthroughId: ctx.walkthroughId,
        order,
        severity: input.severity,
        title: input.title,
        description: input.description,
        filePath: input.file_path ?? null,
        startLine: input.start_line ?? null,
        endLine: input.end_line ?? null,
        blockIds: JSON.stringify(blockIds),
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: walkthroughIssues.id,
        set: {
          severity: input.severity,
          title: input.title,
          description: input.description,
          filePath: input.file_path ?? null,
          startLine: input.start_line ?? null,
          endLine: input.end_line ?? null,
          blockIds: JSON.stringify(blockIds),
        },
      })
      .run();

    const issue: WalkthroughIssue = {
      id: issueId,
      severity: input.severity,
      title: input.title,
      description: input.description,
      blockIds,
      ...(input.file_path !== null ? { filePath: input.file_path } : {}),
      ...(input.start_line !== null ? { startLine: input.start_line } : {}),
      ...(input.end_line !== null ? { endLine: input.end_line } : {}),
    };
    issueEvent = issue;
  });
  if (result) return result;
  if (issueEvent) {
    ctx.emit({ type: "issue", data: issueEvent });
  }
  const hasLineAnchor = input.file_path !== null && input.start_line !== null;
  const requiresInlineComment =
    hasLineAnchor && (input.severity === "warning" || input.severity === "critical");
  let nextStepHint: string;
  if (requiresInlineComment) {
    nextStepHint = `\n\nNEXT STEP — REQUIRED: call add_issue_comment with issue_id="${issueId}", file_path="${input.file_path}", start_line=${input.start_line}, end_line=${input.end_line ?? input.start_line}, and a body that explains the concern to the coder (2–6 sentences, markdown, second-person voice). Without that follow-up call this issue has no inline comment in the diff and complete_walkthrough will reject. If the concern affects multiple call-sites, call add_issue_comment once per line range with the same issue_id.`;
  } else if (input.severity === "info") {
    nextStepHint = `\n\n(Severity 'info' — nitpick, no inline comment needed. Continue with the next concern or diff step.)`;
  } else {
    // warning/critical without a line anchor → PR-wide, no anchor possible
    nextStepHint = `\n\n(PR-wide issue with no line anchor — no inline comment needed. Continue with the next concern or diff step.)`;
  }
  return okResult(
    `Issue flagged: [${input.severity}] ${input.title} (id: ${issueId}).${nextStepHint}`,
  );
};

// ── Handler: add_issue_comment (Phase B) ─────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'A', 'B'} (same as flag_issue —
// comments are line-level evidence for issues, both are Phase B artifacts).
// Cross-reference precondition: input.issue_id must point at a walkthrough
// issue belonging to ctx.walkthroughId.
//
// Writes (one transaction): one `comment_threads` row + one `thread_messages`
// row, both keyed on deterministic ids so retries upsert in place. Does NOT
// advance phase. After commit broadcasts a `thread:created` SSE event so any
// open `DiffViewerInner` re-renders inline at the anchor.
//
// Idempotency:
//   thread.id   = computeAnchorThreadId(walkthroughId, issueId, file, l1, l2, side)
//   message.id  = `${thread.id}-msg-0`
// A retry with the same anchor replaces the message body in place rather than
// stacking duplicate threads.

export const addIssueCommentHandler: WalkthroughToolHandler<AddIssueCommentInput> = async (
  ctx,
  input,
) => {
  if (input.end_line < input.start_line) {
    return errorResult(
      `Error: end_line (${input.end_line}) is before start_line (${input.start_line}). Use end_line === start_line for a single-line comment.`,
    );
  }

  // Hashing happens before the transaction — sha256 is deterministic and the
  // inputs are already validated, so doing it outside DB scope keeps the
  // transaction tight.
  const threadId = await computeAnchorThreadId(
    ctx.walkthroughId,
    input.issue_id,
    input.file_path,
    input.start_line,
    input.end_line,
    input.diff_side,
  );
  const messageId = `${threadId}-msg-0`;

  let result: WalkthroughToolResult | null = null;
  let createdThread: CommentThread | null = null;
  let createdMessage: ThreadMessage | null = null;
  let sessionId = "";
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (!phaseAtLeast(phase, "A") || !phaseAtMost(phase, "B")) {
      result = errorResult(
        `Error: add_issue_comment is only valid during Phase A/B. Current phase: '${phase}'. Comments are line-level evidence for issues; they belong with the diff analysis, not after sentiment or rating.`,
      );
      return;
    }

    // Cross-reference: the issue must exist for this walkthrough.
    const issueRow = ctx.db
      .select({
        id: walkthroughIssues.id,
        title: walkthroughIssues.title,
      })
      .from(walkthroughIssues)
      .where(
        and(
          eq(walkthroughIssues.id, input.issue_id),
          eq(walkthroughIssues.walkthroughId, ctx.walkthroughId),
        ),
      )
      .get();
    if (!issueRow) {
      result = errorResult(
        `Error: issue_id '${input.issue_id}' does not match any flagged issue for this walkthrough. Call flag_issue first; the result text contains the issue id you must pass back here.`,
      );
      return;
    }

    sessionId = row.reviewSessionId;
    const now = new Date().toISOString();

    // Upsert comment_threads row keyed on deterministic threadId.
    // A retry with the same anchor lands here as a no-op (we keep the row
    // untouched — only the message body, below, ever changes on retry).
    ctx.db
      .insert(commentThreads)
      .values({
        id: threadId,
        reviewSessionId: sessionId,
        filePath: input.file_path,
        startLine: input.start_line,
        endLine: input.end_line,
        diffSide: input.diff_side,
        status: "open",
        createdAt: now,
        walkthroughIssueId: input.issue_id,
      })
      .onConflictDoNothing({ target: commentThreads.id })
      .run();

    // Upsert thread_messages row — one message per thread for AI authors.
    // On retry we replace the body and stamp editedAt; the row id is
    // deterministic so we never accumulate duplicates.
    ctx.db
      .insert(threadMessages)
      .values({
        id: messageId,
        threadId,
        authorRole: "ai_agent",
        authorName: "Revv AI",
        authorLogin: null,
        body: input.body,
        messageType: "comment",
        codeSuggestion: null,
        createdAt: now,
        editedAt: null,
        externalId: null,
      })
      .onConflictDoUpdate({
        target: threadMessages.id,
        set: {
          body: input.body,
          editedAt: now,
        },
      })
      .run();

    // Read back the canonical rows so the broadcast payload reflects what's
    // actually persisted (matches the shape POST /api/reviews/:id/threads
    // emits today).
    const persistedThread = ctx.db
      .select()
      .from(commentThreads)
      .where(eq(commentThreads.id, threadId))
      .get();
    const persistedMessage = ctx.db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.id, messageId))
      .get();
    if (!persistedThread || !persistedMessage) {
      result = errorResult(
        "Internal error: comment_threads / thread_messages upsert succeeded but read-back returned no row.",
      );
      return;
    }

    createdThread = {
      id: persistedThread.id,
      reviewSessionId: persistedThread.reviewSessionId,
      filePath: persistedThread.filePath,
      startLine: persistedThread.startLine,
      endLine: persistedThread.endLine,
      diffSide: persistedThread.diffSide as CommentThread["diffSide"],
      status: persistedThread.status as CommentThread["status"],
      createdAt: persistedThread.createdAt,
      resolvedAt: persistedThread.resolvedAt ?? null,
      externalThreadId: persistedThread.externalThreadId ?? null,
      externalCommentId: persistedThread.externalCommentId ?? null,
      lastSyncedAt: persistedThread.lastSyncedAt ?? null,
    };
    createdMessage = {
      id: persistedMessage.id,
      threadId: persistedMessage.threadId,
      authorRole: persistedMessage.authorRole as ThreadMessage["authorRole"],
      authorName: persistedMessage.authorName,
      authorLogin: persistedMessage.authorLogin ?? null,
      authorAvatarContent: null,
      body: persistedMessage.body,
      messageType: persistedMessage.messageType as ThreadMessage["messageType"],
      codeSuggestion: persistedMessage.codeSuggestion ?? null,
      createdAt: persistedMessage.createdAt,
      editedAt: persistedMessage.editedAt ?? null,
      externalId: persistedMessage.externalId ?? null,
    };
  });
  if (result) return result;
  if (!createdThread || !createdMessage) {
    return errorResult(
      "Internal error: add_issue_comment reached emit without a persisted thread + message.",
    );
  }

  // Commit-first / broadcast-second (doctrine invariant #8). We always emit
  // thread:created — `DiffViewerInner` dedupes by thread id, so retried
  // upserts are harmless on the UI side.
  ctx.broadcastThreadEvent({
    type: "thread:created",
    data: {
      sessionId,
      thread: createdThread,
      message: createdMessage,
    },
  });

  return okResult(
    `Comment posted on ${input.file_path}:${input.start_line}${
      input.end_line !== input.start_line ? `-${input.end_line}` : ""
    } (${input.diff_side} side) for issue ${input.issue_id}. Thread id: ${threadId}.`,
  );
};
