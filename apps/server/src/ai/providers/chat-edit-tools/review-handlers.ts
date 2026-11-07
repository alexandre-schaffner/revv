// A GitHub-submitted issue and its comments are immutable (invariant 7).

import type { WalkthroughRating } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db";
import { commentThreads } from "../../../db/schema/comment-threads";
import { threadMessages } from "../../../db/schema/thread-messages";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { NotFoundError } from "../../../domain/errors";
import { threadWrites } from "../../../services/Review";
import {
  decodeCitations,
  decodeIssue,
  decodeStringArray,
  deleteIssue,
  issueId as deriveIssueId,
  renderUnknownBlockRefs,
  resolveBlockRefs,
  toCitations,
  upsertIssue,
  upsertIssueComment,
} from "../../../services/walkthrough/content";
import { decodePlainText } from "../agent-text";
import { fail } from "../mcp-tool-gateway";
import { type ChatEdit, runChatEdit } from "./helpers";
import type {
  AddIssueCommentEditInput,
  AddIssueEditInput,
  ChatEditToolHandler,
  DeleteIssueCommentInput,
  DeleteIssueInput,
  DeleteRatingInput,
  UpdateIssueCommentInput,
  UpdateIssueInput,
  UpdateRatingInput,
} from "./spec";

function ratingAt(db: Db, walkthroughId: string, axis: string) {
  return db
    .select()
    .from(walkthroughRatings)
    .where(
      and(eq(walkthroughRatings.walkthroughId, walkthroughId), eq(walkthroughRatings.axis, axis)),
    )
    .get();
}

function issueIn(db: Db, walkthroughId: string, id: string) {
  return db
    .select()
    .from(walkthroughIssues)
    .where(and(eq(walkthroughIssues.id, id), eq(walkthroughIssues.walkthroughId, walkthroughId)))
    .get();
}

function editableIssueComment(
  db: Db,
  walkthroughId: string,
  messageId: string,
  verb: "edit" | "delete",
):
  | { readonly refused: string }
  | {
      readonly message: typeof threadMessages.$inferSelect;
      readonly thread: typeof commentThreads.$inferSelect;
    } {
  const message = db.select().from(threadMessages).where(eq(threadMessages.id, messageId)).get();
  if (!message) return { refused: `Error: no thread message with id='${messageId}' exists.` };
  const thread = db
    .select()
    .from(commentThreads)
    .where(eq(commentThreads.id, message.threadId))
    .get();
  if (!thread) return { refused: `Error: parent thread for message ${messageId} is gone.` };
  if (!thread.walkthroughIssueId) {
    return {
      refused: `Error: thread ${thread.id} is not linked to a walkthrough issue — only AI-authored issue comments can be changed with this tool.`,
    };
  }
  const issue = issueIn(db, walkthroughId, thread.walkthroughIssueId);
  if (!issue) {
    return {
      refused: `Error: comment ${messageId} does not belong to the active walkthrough for this PR.`,
    };
  }
  if (issue.submittedAt !== null) {
    return {
      refused: `Error: parent issue has been pushed to GitHub. Cannot ${verb} comments on submitted issues.`,
    };
  }
  return { message, thread };
}

export const updateRatingHandler: ChatEditToolHandler<UpdateRatingInput> = async (ctx, input) =>
  runChatEdit(ctx, (wt) => {
    const existing = ratingAt(ctx.db, wt.id, input.axis);
    if (!existing) {
      return {
        refused: `Error: no rating exists for axis '${input.axis}'. Chat edits cannot add a rating; a deleted axis comes back only with a regenerate.`,
      };
    }

    const verdict = input.verdict ?? (existing.verdict as WalkthroughRating["verdict"]);
    const confidence = input.confidence ?? (existing.confidence as WalkthroughRating["confidence"]);
    const rationale = input.rationale ?? existing.rationale;
    const details = input.details ?? existing.details;
    const citations = input.citations
      ? toCitations(input.citations)
      : decodeCitations(existing.citations);
    if (verdict !== "pass" && citations.length === 0) {
      return {
        refused: `Error: verdict='${verdict}' requires at least one citation. Provide citations, or set verdict to 'pass'.`,
      };
    }

    let blockIds = decodeStringArray(existing.blockIds);
    if (input.block_refs != null) {
      const refs = resolveBlockRefs(ctx.db, wt.id, input.block_refs);
      if ("unknown" in refs) return { refused: renderUnknownBlockRefs(refs.unknown) };
      blockIds = refs.blockIds;
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
    return {
      message: `Rating for axis '${input.axis}' updated.`,
      events: [
        {
          type: "rating",
          data: { axis: input.axis, verdict, confidence, rationale, details, citations, blockIds },
        },
      ],
    };
  });

export const deleteRatingHandler: ChatEditToolHandler<DeleteRatingInput> = async (ctx, input) =>
  runChatEdit(ctx, (wt) => {
    const existing = ratingAt(ctx.db, wt.id, input.axis);
    if (!existing) return { refused: `Error: no rating exists for axis '${input.axis}'.` };
    ctx.db.delete(walkthroughRatings).where(eq(walkthroughRatings.id, existing.id)).run();
    return {
      message: `Rating for axis '${input.axis}' deleted. (status stays 'complete'; passesCompletenessGate may now be false.)`,
      events: [{ type: "rating:deleted", data: { axis: input.axis } }],
    };
  });

export const addIssueEditHandler: ChatEditToolHandler<AddIssueEditInput> = async (ctx, input) => {
  // Normalized before hashing: the id derives from the title.
  const title = decodePlainText(input.title);
  const description = decodePlainText(input.description);

  return runChatEdit(ctx, (wt) => {
    const refs = resolveBlockRefs(ctx.db, wt.id, input.block_refs);
    if ("unknown" in refs) return { refused: renderUnknownBlockRefs(refs.unknown) };

    const id = deriveIssueId(wt.id, title, input.file_path, input.start_line);
    if (issueIn(ctx.db, wt.id, id)) {
      return {
        refused: `Error: an issue with title '${input.title}' at ${input.file_path ?? "(no file)"}:${input.start_line ?? "?"} already exists (id=${id}). Use update_issue with that id to modify it.`,
      };
    }

    const row = upsertIssue(ctx.db, wt.id, {
      severity: input.severity,
      title,
      description,
      filePath: input.file_path,
      startLine: input.start_line,
      endLine: input.end_line,
      blockIds: refs.blockIds,
    });
    return {
      message: `Issue added: [${input.severity}] ${input.title} (id=${id}).`,
      events: [{ type: "issue", data: decodeIssue(row) }],
    };
  });
};

export const updateIssueHandler: ChatEditToolHandler<UpdateIssueInput> = async (ctx, input) =>
  runChatEdit(ctx, (wt) => {
    const existing = issueIn(ctx.db, wt.id, input.issue_id);
    if (!existing) {
      return {
        refused: `Error: no issue with id='${input.issue_id}' exists in the active walkthrough.`,
      };
    }
    if (existing.submittedAt !== null) {
      return {
        refused: `Error: issue '${existing.title}' has been pushed to GitHub (submittedAt=${existing.submittedAt}). Submitted issues are immutable.`,
      };
    }

    let blockIds: string[] | null = null;
    if (input.block_refs != null) {
      const refs = resolveBlockRefs(ctx.db, wt.id, input.block_refs);
      if ("unknown" in refs) return { refused: renderUnknownBlockRefs(refs.unknown) };
      blockIds = refs.blockIds;
    }

    const patch: Partial<typeof walkthroughIssues.$inferInsert> = {
      ...(input.severity != null ? { severity: input.severity } : {}),
      ...(input.title != null ? { title: decodePlainText(input.title) } : {}),
      ...(input.description != null ? { description: decodePlainText(input.description) } : {}),
      ...(input.file_path !== undefined ? { filePath: input.file_path } : {}),
      ...(input.start_line !== undefined ? { startLine: input.start_line } : {}),
      ...(input.end_line !== undefined ? { endLine: input.end_line } : {}),
      ...(blockIds !== null ? { blockIds: JSON.stringify(blockIds) } : {}),
    };
    if (Object.keys(patch).length === 0) {
      return { refused: "Error: update_issue needs at least one field to update." };
    }

    ctx.db.update(walkthroughIssues).set(patch).where(eq(walkthroughIssues.id, existing.id)).run();
    const row = issueIn(ctx.db, wt.id, existing.id);
    return {
      message: `Issue ${input.issue_id} updated.`,
      events: row ? [{ type: "issue", data: decodeIssue(row) }] : [],
    };
  });

export const deleteIssueHandler: ChatEditToolHandler<DeleteIssueInput> = async (ctx, input) =>
  runChatEdit(ctx, (wt) => {
    const existing = issueIn(ctx.db, wt.id, input.issue_id);
    if (!existing) return { refused: `Error: no issue with id='${input.issue_id}' exists.` };
    if (existing.submittedAt !== null) {
      return {
        refused: `Error: issue '${existing.title}' has been pushed to GitHub (submittedAt=${existing.submittedAt}). Cannot delete.`,
      };
    }

    const threadEvents = deleteIssue(ctx.db, existing.id);
    return {
      message: `Issue ${input.issue_id} deleted${threadEvents.length > 0 ? ` (${threadEvents.length} linked thread(s) cascaded)` : ""}.`,
      threadEvents,
      events: [{ type: "issue:deleted", data: { id: input.issue_id } }],
    };
  });

export const addIssueCommentEditHandler: ChatEditToolHandler<AddIssueCommentEditInput> = async (
  ctx,
  input,
) => {
  if (input.end_line < input.start_line) {
    return fail(`Error: end_line (${input.end_line}) is before start_line (${input.start_line}).`);
  }

  return runChatEdit(ctx, (wt): ChatEdit => {
    const issue = issueIn(ctx.db, wt.id, input.issue_id);
    if (!issue) {
      return {
        refused: `Error: no issue with id='${input.issue_id}' exists in the active walkthrough.`,
      };
    }
    if (issue.submittedAt !== null) {
      return {
        refused: `Error: issue '${input.issue_id}' has been pushed to GitHub. Cannot add comments to submitted issues.`,
      };
    }

    const written = upsertIssueComment(ctx.db, {
      walkthroughId: wt.id,
      prId: ctx.prId,
      issueId: input.issue_id,
      filePath: input.file_path,
      startLine: input.start_line,
      endLine: input.end_line,
      diffSide: input.diff_side,
      body: input.body,
    });
    return {
      message: `Comment posted on ${input.file_path}:${input.start_line}${
        input.end_line !== input.start_line ? `-${input.end_line}` : ""
      } for issue ${input.issue_id}. Thread id: ${written.value.thread.id}.`,
      threadEvents: written.envelopes,
    };
  });
};

export const updateIssueCommentHandler: ChatEditToolHandler<UpdateIssueCommentInput> = async (
  ctx,
  input,
) =>
  runChatEdit(ctx, (wt) => {
    const found = editableIssueComment(ctx.db, wt.id, input.thread_message_id, "edit");
    if ("refused" in found) return found;
    const edited = threadWrites.editMessage(ctx.db, found.message.id, input.body);
    if (edited instanceof NotFoundError) return { refused: `Error: ${edited.message}` };
    return {
      message: `Comment ${input.thread_message_id} updated.`,
      threadEvents: edited.envelopes,
    };
  });

export const deleteIssueCommentHandler: ChatEditToolHandler<DeleteIssueCommentInput> = async (
  ctx,
  input,
) =>
  runChatEdit(ctx, (wt) => {
    const found = editableIssueComment(ctx.db, wt.id, input.thread_message_id, "delete");
    if ("refused" in found) return found;
    const removed = threadWrites.removeMessage(ctx.db, found.thread.id, found.message.id);
    if (removed instanceof NotFoundError) return { refused: `Error: ${removed.message}` };
    const threadRemoved = removed.envelopes.some((e) => e.type === "thread:deleted");
    return {
      message: `Comment ${input.thread_message_id} deleted${threadRemoved ? " with its thread (it was the thread's first message)" : ""}.`,
      threadEvents: removed.envelopes,
    };
  });
