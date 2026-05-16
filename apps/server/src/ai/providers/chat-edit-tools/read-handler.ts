// ── chat-edit-read-handler ───────────────────────────────────────────────────
//
// Read-only handler: get_walkthrough_for_edit.

import type { WalkthroughBlock } from "@revv/shared";
import { eq, inArray } from "drizzle-orm";
import { commentThreads } from "../../../db/schema/comment-threads";
import { threadMessages } from "../../../db/schema/thread-messages";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { findIssuesMissingInlineComment } from "../walkthrough-tools";
import {
  decodeBlock,
  decodeIssue,
  decodeRating,
  fail,
  ok,
  resolveActiveWalkthroughId,
} from "./helpers";
import type { ChatEditToolHandler, GetWalkthroughForEditInput } from "./spec";

// ── Tool: get_walkthrough_for_edit ──────────────────────────────────────────

export const getWalkthroughForEditHandler: ChatEditToolHandler<GetWalkthroughForEditInput> = async (
  ctx,
) => {
  const row = resolveActiveWalkthroughId(ctx.db, ctx.prId);
  if (!row) {
    return fail(
      `No complete walkthrough exists for this PR yet. Ask the user to generate one first.`,
    );
  }

  const semanticRows = ctx.db
    .select()
    .from(walkthroughSemanticSteps)
    .where(eq(walkthroughSemanticSteps.walkthroughId, row.id))
    .orderBy(walkthroughSemanticSteps.semanticStepIndex)
    .all();

  const blockRows = ctx.db
    .select()
    .from(walkthroughBlocks)
    .where(eq(walkthroughBlocks.walkthroughId, row.id))
    .orderBy(walkthroughBlocks.semanticStepIndex, walkthroughBlocks.stepIndex)
    .all();

  const issueRows = ctx.db
    .select()
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, row.id))
    .orderBy(walkthroughIssues.order)
    .all();

  const ratingRows = ctx.db
    .select()
    .from(walkthroughRatings)
    .where(eq(walkthroughRatings.walkthroughId, row.id))
    .all();

  // Comment threads linked to issues in this walkthrough.
  const issueIds = issueRows.map((i) => i.id);
  const threadRows =
    issueIds.length > 0
      ? ctx.db
          .select()
          .from(commentThreads)
          .where(inArray(commentThreads.walkthroughIssueId, issueIds))
          .all()
      : [];
  const threadIds = threadRows.map((t) => t.id);
  const messageRows =
    threadIds.length > 0
      ? ctx.db
          .select()
          .from(threadMessages)
          .where(inArray(threadMessages.threadId, threadIds))
          .orderBy(threadMessages.createdAt)
          .all()
      : [];

  const stepIndicesBySection = new Map<number, number[]>();
  for (const b of blockRows) {
    const arr = stepIndicesBySection.get(b.semanticStepIndex) ?? [];
    arr.push(b.stepIndex);
    stepIndicesBySection.set(b.semanticStepIndex, arr);
  }

  const missingComments = findIssuesMissingInlineComment(ctx.db, row.id);
  const ratedAxes = new Set(ratingRows.map((r) => r.axis));
  const requiredAxes = [
    "correctness",
    "scope",
    "tests",
    "clarity",
    "safety",
    "consistency",
    "api_changes",
    "performance",
    "description",
  ];
  const missingAxes = requiredAxes.filter((a) => !ratedAxes.has(a));

  const payload = {
    walkthroughId: row.id,
    prHeadSha: row.prHeadSha,
    status: row.status,
    lastCompletedPhase: row.lastCompletedPhase,
    lastEditedAt: row.lastEditedAt,
    lastEditedBy: row.lastEditedBy,
    summary: row.summary,
    riskLevel: row.riskLevel,
    sentiment: row.sentiment,
    semanticSteps: semanticRows.map((s) => ({
      semanticStepIndex: s.semanticStepIndex,
      title: s.title,
      summary: s.summary,
      stepIndices: (stepIndicesBySection.get(s.semanticStepIndex) ?? [])
        .slice()
        .sort((a, b) => a - b),
    })),
    blocks: blockRows
      .map((b) => {
        const decoded = decodeBlock(b);
        return decoded;
      })
      .filter((b): b is WalkthroughBlock => b !== null),
    issues: issueRows.map(decodeIssue),
    ratings: ratingRows.map(decodeRating),
    comments: messageRows.map((m) => {
      const thread = threadRows.find((t) => t.id === m.threadId);
      return {
        threadMessageId: m.id,
        threadId: m.threadId,
        issueId: thread?.walkthroughIssueId ?? null,
        body: m.body,
        filePath: thread?.filePath ?? null,
        startLine: thread?.startLine ?? null,
        endLine: thread?.endLine ?? null,
        diffSide: thread?.diffSide ?? null,
        authorRole: m.authorRole,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
      };
    }),
    validation: {
      passesCompletenessGate: missingComments.length === 0 && missingAxes.length === 0,
      missingInlineComments: missingComments.map((m) => ({
        id: m.id,
        severity: m.severity,
        title: m.title,
        filePath: m.filePath,
        startLine: m.startLine,
      })),
      missingAxes,
    },
  };

  return ok(JSON.stringify(payload, null, 2));
};
