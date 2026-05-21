// ── chat-edit-review-handlers ────────────────────────────────────────────────
//
// Handlers for ratings, issues, and issue comments.

import type {
  CommentThread,
  RatingCitation,
  ThreadMessage,
  WalkthroughIssue,
  WalkthroughRating,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { commentThreads } from "../../../db/schema/comment-threads";
import { threadMessages } from "../../../db/schema/thread-messages";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { blockIdFor, computeAnchorThreadId, computeIssueId } from "../walkthrough-tools";
import {
  assertStillComplete,
  decodeIssue,
  fail,
  ok,
  parseBlockIds,
  parseCitations,
  resolveActiveWalkthroughId,
  stampLastEdited,
} from "./helpers";
import type {
  AddIssueCommentEditInput,
  AddIssueEditInput,
  ChatEditToolHandler,
  ChatEditToolResult,
  DeleteIssueCommentInput,
  DeleteIssueInput,
  DeleteRatingInput,
  UpdateIssueCommentInput,
  UpdateIssueInput,
  UpdateRatingInput,
} from "./spec";

// ── Tool: update_rating ─────────────────────────────────────────────────────

export const updateRatingHandler: ChatEditToolHandler<UpdateRatingInput> = async (ctx, input) => {
  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let emitRating: WalkthroughRating | null = null;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const existing = ctx.db
      .select()
      .from(walkthroughRatings)
      .where(
        and(
          eq(walkthroughRatings.walkthroughId, walkthroughId),
          eq(walkthroughRatings.axis, input.axis),
        ),
      )
      .get();
    if (!existing) {
      result = fail(
        `Error: no rating exists for axis '${input.axis}'. Use add_rating-style flow (not yet supported) — for now, delete the deleted axis and let the agent re-rate via add_issue's sibling tool. As of v1, deleted ratings cannot be re-added through chat edits.`,
      );
      return;
    }

    const verdict = input.verdict ?? (existing.verdict as WalkthroughRating["verdict"]);
    const confidence = input.confidence ?? (existing.confidence as WalkthroughRating["confidence"]);
    const rationale = input.rationale ?? existing.rationale;
    const details = input.details ?? existing.details;
    const citationsInput = input.citations;
    const citations: RatingCitation[] = citationsInput
      ? citationsInput.map((c) => ({
          filePath: c.file_path,
          startLine: c.start_line,
          endLine: c.end_line,
          ...(c.note !== null ? { note: c.note } : {}),
        }))
      : parseCitations(existing.citations);
    if (verdict !== "pass" && citations.length === 0) {
      result = fail(
        `Error: verdict='${verdict}' requires at least one citation. Provide citations, or set verdict to 'pass'.`,
      );
      return;
    }

    let blockIds: string[];
    if (input.block_refs != null) {
      // Validate refs exist.
      const stepRows = ctx.db
        .select({
          semanticStepIndex: walkthroughBlocks.semanticStepIndex,
          stepIndex: walkthroughBlocks.stepIndex,
        })
        .from(walkthroughBlocks)
        .where(
          and(
            eq(walkthroughBlocks.walkthroughId, walkthroughId),
            eq(walkthroughBlocks.phase, "diff_analysis"),
          ),
        )
        .all();
      const known = new Set(stepRows.map((r) => `${r.semanticStepIndex}:${r.stepIndex}`));
      const unknown = input.block_refs.filter(
        (r) => !known.has(`${r.semantic_step_index}:${r.step_index}`),
      );
      if (unknown.length > 0) {
        result = fail(
          `Error: block_refs reference unknown blocks: [${unknown.map((r) => `(${r.semantic_step_index},${r.step_index})`).join(", ")}].`,
        );
        return;
      }
      const seen = new Set<string>();
      const unique = input.block_refs.filter((r) => {
        const k = `${r.semantic_step_index}:${r.step_index}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      blockIds = unique.map((r) => blockIdFor(walkthroughId, r.semantic_step_index, r.step_index));
    } else {
      blockIds = parseBlockIds(existing.blockIds);
    }

    ctx.db
      .update(walkthroughRatings)
      .set({
        verdict,
        confidence,
        rationale,
        details,
        citations: JSON.stringify(citations),
        blockIds: JSON.stringify(blockIds),
      })
      .where(eq(walkthroughRatings.id, existing.id))
      .run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);

    emitRating = {
      axis: input.axis,
      verdict,
      confidence,
      rationale,
      details,
      citations,
      blockIds,
    };
  });
  if (result) return result;
  if (!emitRating) return fail("Internal error: update_rating did not persist.");

  ctx.emit(walkthroughId, { type: "rating", data: emitRating });
  return ok(`Rating for axis '${input.axis}' updated.`);
};

// ── Tool: delete_rating ─────────────────────────────────────────────────────

export const deleteRatingHandler: ChatEditToolHandler<DeleteRatingInput> = async (ctx, input) => {
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
    const existing = ctx.db
      .select({ id: walkthroughRatings.id })
      .from(walkthroughRatings)
      .where(
        and(
          eq(walkthroughRatings.walkthroughId, walkthroughId),
          eq(walkthroughRatings.axis, input.axis),
        ),
      )
      .get();
    if (!existing) {
      result = fail(`Error: no rating exists for axis '${input.axis}'.`);
      return;
    }
    ctx.db.delete(walkthroughRatings).where(eq(walkthroughRatings.id, existing.id)).run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);
  });
  if (result) return result;

  ctx.emit(walkthroughId, {
    type: "rating:deleted",
    data: { axis: input.axis },
  });
  return ok(
    `Rating for axis '${input.axis}' deleted. (status stays 'complete'; passesCompletenessGate may now be false.)`,
  );
};

// ── Tool: add_issue ─────────────────────────────────────────────────────────

export const addIssueEditHandler: ChatEditToolHandler<AddIssueEditInput> = async (ctx, input) => {
  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  const issueId = await computeIssueId(
    walkthroughId,
    input.title,
    input.file_path,
    input.start_line,
  );

  let result: ChatEditToolResult | null = null;
  let emitIssue: WalkthroughIssue | null = null;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    // Validate block_refs.
    const stepRows = ctx.db
      .select({
        semanticStepIndex: walkthroughBlocks.semanticStepIndex,
        stepIndex: walkthroughBlocks.stepIndex,
      })
      .from(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, walkthroughId),
          eq(walkthroughBlocks.phase, "diff_analysis"),
        ),
      )
      .all();
    const known = new Set(stepRows.map((r) => `${r.semanticStepIndex}:${r.stepIndex}`));
    const unknown = input.block_refs.filter(
      (r) => !known.has(`${r.semantic_step_index}:${r.step_index}`),
    );
    if (unknown.length > 0) {
      result = fail(
        `Error: block_refs reference unknown blocks: [${unknown.map((r) => `(${r.semantic_step_index},${r.step_index})`).join(", ")}].`,
      );
      return;
    }

    // Refuse if an issue with the same id already exists — the agent
    // should use update_issue instead.
    const existing = ctx.db
      .select({ id: walkthroughIssues.id })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.id, issueId))
      .get();
    if (existing) {
      result = fail(
        `Error: an issue with title '${input.title}' at ${input.file_path ?? "(no file)"}:${input.start_line ?? "?"} already exists (id=${issueId}). Use update_issue with that id to modify it.`,
      );
      return;
    }

    const seen = new Set<string>();
    const unique = input.block_refs.filter((r) => {
      const k = `${r.semantic_step_index}:${r.step_index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const blockIds = unique.map((r) =>
      blockIdFor(walkthroughId, r.semantic_step_index, r.step_index),
    );

    const existingRows = ctx.db
      .select({ order: walkthroughIssues.order })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
      .all();
    const order = existingRows.length;
    const now = new Date().toISOString();
    ctx.db
      .insert(walkthroughIssues)
      .values({
        id: issueId,
        walkthroughId,
        order,
        severity: input.severity,
        title: input.title,
        description: input.description,
        filePath: input.file_path,
        startLine: input.start_line,
        endLine: input.end_line,
        blockIds: JSON.stringify(blockIds),
        createdAt: now,
      })
      .run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);

    emitIssue = {
      id: issueId,
      severity: input.severity,
      title: input.title,
      description: input.description,
      blockIds,
      ...(input.file_path !== null ? { filePath: input.file_path } : {}),
      ...(input.start_line !== null ? { startLine: input.start_line } : {}),
      ...(input.end_line !== null ? { endLine: input.end_line } : {}),
    };
  });
  if (result) return result;
  if (!emitIssue) return fail("Internal error: add_issue did not persist.");

  ctx.emit(walkthroughId, { type: "issue", data: emitIssue });
  return ok(`Issue added: [${input.severity}] ${input.title} (id=${issueId}).`);
};

// ── Tool: update_issue ──────────────────────────────────────────────────────

export const updateIssueHandler: ChatEditToolHandler<UpdateIssueInput> = async (ctx, input) => {
  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let emitIssue: WalkthroughIssue | null = null;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const existing = ctx.db
      .select()
      .from(walkthroughIssues)
      .where(
        and(
          eq(walkthroughIssues.id, input.issue_id),
          eq(walkthroughIssues.walkthroughId, walkthroughId),
        ),
      )
      .get();
    if (!existing) {
      result = fail(
        `Error: no issue with id='${input.issue_id}' exists in the active walkthrough.`,
      );
      return;
    }
    if (existing.submittedAt !== null) {
      result = fail(
        `Error: issue '${existing.title}' has been pushed to GitHub (submittedAt=${existing.submittedAt}). Submitted issues are immutable.`,
      );
      return;
    }

    let blockIds = parseBlockIds(existing.blockIds);
    if (input.block_refs != null) {
      const stepRows = ctx.db
        .select({
          semanticStepIndex: walkthroughBlocks.semanticStepIndex,
          stepIndex: walkthroughBlocks.stepIndex,
        })
        .from(walkthroughBlocks)
        .where(
          and(
            eq(walkthroughBlocks.walkthroughId, walkthroughId),
            eq(walkthroughBlocks.phase, "diff_analysis"),
          ),
        )
        .all();
      const known = new Set(stepRows.map((r) => `${r.semanticStepIndex}:${r.stepIndex}`));
      const unknown = input.block_refs.filter(
        (r) => !known.has(`${r.semantic_step_index}:${r.step_index}`),
      );
      if (unknown.length > 0) {
        result = fail(
          `Error: block_refs reference unknown blocks: [${unknown.map((r) => `(${r.semantic_step_index},${r.step_index})`).join(", ")}].`,
        );
        return;
      }
      const seen = new Set<string>();
      const unique = input.block_refs.filter((r) => {
        const k = `${r.semantic_step_index}:${r.step_index}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      blockIds = unique.map((r) => blockIdFor(walkthroughId, r.semantic_step_index, r.step_index));
    }

    const patch: {
      severity?: string;
      title?: string;
      description?: string;
      filePath?: string | null;
      startLine?: number | null;
      endLine?: number | null;
      blockIds?: string;
    } = {};
    if (input.severity != null) patch.severity = input.severity;
    if (input.title != null) patch.title = input.title;
    if (input.description != null) patch.description = input.description;
    if ("file_path" in input && input.file_path !== undefined) patch.filePath = input.file_path;
    if ("start_line" in input && input.start_line !== undefined) patch.startLine = input.start_line;
    if ("end_line" in input && input.end_line !== undefined) patch.endLine = input.end_line;
    if (input.block_refs != null) patch.blockIds = JSON.stringify(blockIds);

    if (Object.keys(patch).length === 0) {
      result = fail("Error: update_issue needs at least one field to update.");
      return;
    }

    ctx.db.update(walkthroughIssues).set(patch).where(eq(walkthroughIssues.id, existing.id)).run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);

    const updatedRow = { ...existing, ...patch } as typeof existing;
    emitIssue = decodeIssue(updatedRow);
  });
  if (result) return result;
  if (!emitIssue) return fail("Internal error: update_issue did not persist.");

  ctx.emit(walkthroughId, { type: "issue", data: emitIssue });
  return ok(`Issue ${input.issue_id} updated.`);
};

// ── Tool: delete_issue ──────────────────────────────────────────────────────

export const deleteIssueHandler: ChatEditToolHandler<DeleteIssueInput> = async (ctx, input) => {
  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  const deletedThreadIds: string[] = [];
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const existing = ctx.db
      .select()
      .from(walkthroughIssues)
      .where(
        and(
          eq(walkthroughIssues.id, input.issue_id),
          eq(walkthroughIssues.walkthroughId, walkthroughId),
        ),
      )
      .get();
    if (!existing) {
      result = fail(`Error: no issue with id='${input.issue_id}' exists.`);
      return;
    }
    if (existing.submittedAt !== null) {
      result = fail(
        `Error: issue '${existing.title}' has been pushed to GitHub (submittedAt=${existing.submittedAt}). Cannot delete.`,
      );
      return;
    }

    // Capture linked thread ids before the FK cascade fires so we can
    // broadcast `thread:deleted` events post-commit.
    const linkedThreads = ctx.db
      .select({ id: commentThreads.id })
      .from(commentThreads)
      .where(eq(commentThreads.walkthroughIssueId, existing.id))
      .all();
    for (const t of linkedThreads) deletedThreadIds.push(t.id);

    // FK on comment_threads.walkthroughIssueId is ON DELETE CASCADE — the
    // linked threads (and their messages via thread cascade) drop with the
    // issue.
    ctx.db.delete(walkthroughIssues).where(eq(walkthroughIssues.id, existing.id)).run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);
  });
  if (result) return result;

  for (const threadId of deletedThreadIds) {
    ctx.broadcastThreadEvent({ type: "thread:deleted", data: { threadId } });
  }
  ctx.emit(walkthroughId, { type: "issue:deleted", data: { id: input.issue_id } });
  return ok(
    `Issue ${input.issue_id} deleted${deletedThreadIds.length > 0 ? ` (${deletedThreadIds.length} linked thread(s) cascaded)` : ""}.`,
  );
};

// ── Tool: add_issue_comment ─────────────────────────────────────────────────

export const addIssueCommentEditHandler: ChatEditToolHandler<AddIssueCommentEditInput> = async (
  ctx,
  input,
) => {
  if (input.end_line < input.start_line) {
    return fail(`Error: end_line (${input.end_line}) is before start_line (${input.start_line}).`);
  }

  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  const threadId = await computeAnchorThreadId(
    walkthroughId,
    input.issue_id,
    input.file_path,
    input.start_line,
    input.end_line,
    input.diff_side,
  );
  const messageId = `${threadId}-msg-0`;

  let result: ChatEditToolResult | null = null;
  let createdThread: CommentThread | null = null;
  let createdMessage: ThreadMessage | null = null;
  let sessionId = "";
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const issue = ctx.db
      .select({
        id: walkthroughIssues.id,
        submittedAt: walkthroughIssues.submittedAt,
      })
      .from(walkthroughIssues)
      .where(
        and(
          eq(walkthroughIssues.id, input.issue_id),
          eq(walkthroughIssues.walkthroughId, walkthroughId),
        ),
      )
      .get();
    if (!issue) {
      result = fail(
        `Error: no issue with id='${input.issue_id}' exists in the active walkthrough.`,
      );
      return;
    }
    if (issue.submittedAt !== null) {
      result = fail(
        `Error: issue '${input.issue_id}' has been pushed to GitHub. Cannot add comments to submitted issues.`,
      );
      return;
    }

    sessionId = guarded.row.reviewSessionId;
    const now = new Date().toISOString();

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
        set: { body: input.body, editedAt: now },
      })
      .run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);

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
      result = fail("Internal error: comment upsert succeeded but read-back returned no row.");
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
    return fail("Internal error: add_issue_comment did not persist.");
  }

  ctx.broadcastThreadEvent({
    type: "thread:created",
    data: { sessionId, thread: createdThread, message: createdMessage },
  });
  return ok(
    `Comment posted on ${input.file_path}:${input.start_line}${
      input.end_line !== input.start_line ? `-${input.end_line}` : ""
    } for issue ${input.issue_id}. Thread id: ${threadId}.`,
  );
};

// ── Tool: update_issue_comment ──────────────────────────────────────────────

export const updateIssueCommentHandler: ChatEditToolHandler<UpdateIssueCommentInput> = async (
  ctx,
  input,
) => {
  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let updatedMessage: ThreadMessage | null = null;
  let parentThreadId = "";
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const message = ctx.db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.id, input.thread_message_id))
      .get();
    if (!message) {
      result = fail(`Error: no thread message with id='${input.thread_message_id}' exists.`);
      return;
    }
    const thread = ctx.db
      .select()
      .from(commentThreads)
      .where(eq(commentThreads.id, message.threadId))
      .get();
    if (!thread) {
      result = fail(`Error: parent thread for message ${input.thread_message_id} is gone.`);
      return;
    }
    if (!thread.walkthroughIssueId) {
      result = fail(
        `Error: thread ${thread.id} is not linked to a walkthrough issue — only AI-authored issue comments can be edited via this tool.`,
      );
      return;
    }
    const issue = ctx.db
      .select({
        id: walkthroughIssues.id,
        walkthroughId: walkthroughIssues.walkthroughId,
        submittedAt: walkthroughIssues.submittedAt,
      })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.id, thread.walkthroughIssueId))
      .get();
    if (!issue || issue.walkthroughId !== walkthroughId) {
      result = fail(
        `Error: comment ${input.thread_message_id} does not belong to the active walkthrough for this PR.`,
      );
      return;
    }
    if (issue.submittedAt !== null) {
      result = fail(
        `Error: parent issue has been pushed to GitHub. Cannot edit comments on submitted issues.`,
      );
      return;
    }

    const now = new Date().toISOString();
    ctx.db
      .update(threadMessages)
      .set({ body: input.body, editedAt: now })
      .where(eq(threadMessages.id, message.id))
      .run();
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);

    parentThreadId = thread.id;
    updatedMessage = {
      id: message.id,
      threadId: message.threadId,
      authorRole: message.authorRole as ThreadMessage["authorRole"],
      authorName: message.authorName,
      authorLogin: message.authorLogin ?? null,
      authorAvatarContent: null,
      body: input.body,
      messageType: message.messageType as ThreadMessage["messageType"],
      codeSuggestion: message.codeSuggestion ?? null,
      createdAt: message.createdAt,
      editedAt: now,
      externalId: message.externalId ?? null,
    };
  });
  if (result) return result;
  if (!updatedMessage) {
    return fail("Internal error: update_issue_comment did not persist.");
  }

  ctx.broadcastThreadEvent({
    type: "thread:message:edited",
    data: { threadId: parentThreadId, message: updatedMessage },
  });
  return ok(`Comment ${input.thread_message_id} updated.`);
};

// ── Tool: delete_issue_comment ──────────────────────────────────────────────

export const deleteIssueCommentHandler: ChatEditToolHandler<DeleteIssueCommentInput> = async (
  ctx,
  input,
) => {
  const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!active) return fail("No complete walkthrough exists for this PR yet.");
  const walkthroughId = active.id;

  let result: ChatEditToolResult | null = null;
  let parentThreadId = "";
  let threadAlsoDeleted = false;
  ctx.db.transaction(() => {
    const guarded = assertStillComplete(ctx.db, walkthroughId);
    if ("error" in guarded) {
      result = fail(guarded.error);
      return;
    }

    const message = ctx.db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.id, input.thread_message_id))
      .get();
    if (!message) {
      result = fail(`Error: no thread message with id='${input.thread_message_id}' exists.`);
      return;
    }
    const thread = ctx.db
      .select()
      .from(commentThreads)
      .where(eq(commentThreads.id, message.threadId))
      .get();
    if (!thread) {
      result = fail(`Error: parent thread for message ${input.thread_message_id} is gone.`);
      return;
    }
    if (!thread.walkthroughIssueId) {
      result = fail(`Error: thread ${thread.id} is not linked to a walkthrough issue.`);
      return;
    }
    const issue = ctx.db
      .select({
        id: walkthroughIssues.id,
        walkthroughId: walkthroughIssues.walkthroughId,
        submittedAt: walkthroughIssues.submittedAt,
      })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.id, thread.walkthroughIssueId))
      .get();
    if (!issue || issue.walkthroughId !== walkthroughId) {
      result = fail(
        `Error: comment ${input.thread_message_id} does not belong to the active walkthrough.`,
      );
      return;
    }
    if (issue.submittedAt !== null) {
      result = fail(
        `Error: parent issue has been pushed to GitHub. Cannot delete comments on submitted issues.`,
      );
      return;
    }

    parentThreadId = thread.id;
    ctx.db.delete(threadMessages).where(eq(threadMessages.id, message.id)).run();

    // If the thread is now empty, drop the thread row too.
    const remaining = ctx.db
      .select({ id: threadMessages.id })
      .from(threadMessages)
      .where(eq(threadMessages.threadId, thread.id))
      .all();
    if (remaining.length === 0) {
      ctx.db.delete(commentThreads).where(eq(commentThreads.id, thread.id)).run();
      threadAlsoDeleted = true;
    }
    stampLastEdited(ctx.db, walkthroughId, ctx.actor);
  });
  if (result) return result;

  ctx.broadcastThreadEvent({
    type: "thread:message:deleted",
    data: { threadId: parentThreadId, messageId: input.thread_message_id },
  });
  if (threadAlsoDeleted) {
    ctx.broadcastThreadEvent({
      type: "thread:deleted",
      data: { threadId: parentThreadId },
    });
  }
  return ok(
    `Comment ${input.thread_message_id} deleted${threadAlsoDeleted ? " (thread was empty and was also removed)" : ""}.`,
  );
};
