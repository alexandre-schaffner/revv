// A GitHub-submitted issue and its comments are immutable (invariant 7).

import type { RatingCitation, ThreadEventMessage, WalkthroughRating } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db";
import { commentThreads } from "../../../db/schema/comment-threads";
import { threadMessages } from "../../../db/schema/thread-messages";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { toMessage } from "../../../services/Review";
import {
  decodeCitations,
  decodeIssue,
  decodeStringArray,
  issueId as deriveIssueId,
  renderUnknownBlockRefs,
  resolveBlockRefs,
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

function citationsFrom(
  input: readonly {
    file_path: string;
    start_line: number;
    end_line: number;
    note: string | null;
  }[],
): RatingCitation[] {
  return input.map((c) => ({
    filePath: c.file_path,
    startLine: c.start_line,
    endLine: c.end_line,
    ...(c.note !== null ? { note: c.note } : {}),
  }));
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
      ? citationsFrom(input.citations)
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
    const issues = ctx.db
      .select({ id: walkthroughIssues.id })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, wt.id))
      .all();
    if (issues.some((issue) => issue.id === id)) {
      return {
        refused: `Error: an issue with title '${input.title}' at ${input.file_path ?? "(no file)"}:${input.start_line ?? "?"} already exists (id=${id}). Use update_issue with that id to modify it.`,
      };
    }

    ctx.db
      .insert(walkthroughIssues)
      .values({
        id,
        walkthroughId: wt.id,
        order: issues.length,
        severity: input.severity,
        title,
        description,
        filePath: input.file_path,
        startLine: input.start_line,
        endLine: input.end_line,
        blockIds: JSON.stringify(refs.blockIds),
        createdAt: new Date().toISOString(),
      })
      .run();
    const row = issueIn(ctx.db, wt.id, id);
    return {
      message: `Issue added: [${input.severity}] ${input.title} (id=${id}).`,
      events: row ? [{ type: "issue", data: decodeIssue(row) }] : [],
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

    // The FK cascade drops the linked threads with the issue; their ids are
    // read first so the deletions can be broadcast.
    const threadIds = ctx.db
      .select({ id: commentThreads.id })
      .from(commentThreads)
      .where(eq(commentThreads.walkthroughIssueId, existing.id))
      .all()
      .map((t) => t.id);
    ctx.db.delete(walkthroughIssues).where(eq(walkthroughIssues.id, existing.id)).run();
    return {
      message: `Issue ${input.issue_id} deleted${threadIds.length > 0 ? ` (${threadIds.length} linked thread(s) cascaded)` : ""}.`,
      threadEvents: threadIds.map(
        (threadId): ThreadEventMessage => ({ type: "thread:deleted", data: { threadId } }),
      ),
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

    const { thread, message } = upsertIssueComment(ctx.db, {
      walkthroughId: wt.id,
      reviewSessionId: wt.reviewSessionId,
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
      } for issue ${input.issue_id}. Thread id: ${thread.id}.`,
      threadEvents: [{ type: "thread:created", data: { prId: ctx.prId, thread, message } }],
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
    const editedAt = new Date().toISOString();
    ctx.db
      .update(threadMessages)
      .set({ body: input.body, editedAt })
      .where(eq(threadMessages.id, found.message.id))
      .run();
    return {
      message: `Comment ${input.thread_message_id} updated.`,
      threadEvents: [
        {
          type: "thread:message:edited",
          data: {
            threadId: found.thread.id,
            message: toMessage({ ...found.message, body: input.body, editedAt }, null),
          },
        },
      ],
    };
  });

export const deleteIssueCommentHandler: ChatEditToolHandler<DeleteIssueCommentInput> = async (
  ctx,
  input,
) =>
  runChatEdit(ctx, (wt) => {
    const found = editableIssueComment(ctx.db, wt.id, input.thread_message_id, "delete");
    if ("refused" in found) return found;
    const threadId = found.thread.id;
    ctx.db.delete(threadMessages).where(eq(threadMessages.id, found.message.id)).run();

    const threadEmptied =
      ctx.db
        .select({ id: threadMessages.id })
        .from(threadMessages)
        .where(eq(threadMessages.threadId, threadId))
        .get() === undefined;
    if (threadEmptied) {
      ctx.db.delete(commentThreads).where(eq(commentThreads.id, threadId)).run();
    }
    const threadEvents: ThreadEventMessage[] = [
      { type: "thread:message:deleted", data: { threadId, messageId: input.thread_message_id } },
      ...(threadEmptied
        ? [{ type: "thread:deleted" as const, data: { threadId } } satisfies ThreadEventMessage]
        : []),
    ];
    return {
      message: `Comment ${input.thread_message_id} deleted${threadEmptied ? " (thread was empty and was also removed)" : ""}.`,
      threadEvents,
    };
  });
