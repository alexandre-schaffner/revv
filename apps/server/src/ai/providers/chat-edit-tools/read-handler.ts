// ── chat-edit-read-handler ───────────────────────────────────────────────────
//
// get_walkthrough_for_edit: the targeting keys every edit tool takes.

import { chapterNumbersByIndex, RATING_AXES } from "@revv/shared";
import {
  decodeBlock,
  decodeIssue,
  decodeRating,
  findIssuesMissingInlineComment,
  latestCompleteWalkthrough,
  loadContentRows,
  loadIssueThreads,
} from "../../../services/walkthrough/content";
import { fail, NO_COMPLETE_WALKTHROUGH, ok } from "./helpers";
import type { ChatEditToolHandler, GetWalkthroughForEditInput } from "./spec";

export const getWalkthroughForEditHandler: ChatEditToolHandler<GetWalkthroughForEditInput> = async (
  ctx,
) => {
  const row = latestCompleteWalkthrough(ctx.db, ctx.prId);
  if (!row) return fail(NO_COMPLETE_WALKTHROUGH);

  const content = loadContentRows(ctx.db, row.id);
  const { threads, messages } = loadIssueThreads(
    ctx.db,
    content.issues.map((i) => i.id),
  );
  const threadById = new Map(threads.map((t) => [t.id, t]));

  const stepIndicesBySection = new Map<number, number[]>();
  for (const b of content.blocks) {
    const indices = stepIndicesBySection.get(b.semanticStepIndex) ?? [];
    indices.push(b.stepIndex);
    stepIndicesBySection.set(b.semanticStepIndex, indices);
  }
  const chapterNumbers = chapterNumbersByIndex(
    content.semanticSteps.map((s) => s.semanticStepIndex),
    content.blocks.map((b) => b.semanticStepIndex),
  );

  const missingComments = findIssuesMissingInlineComment(ctx.db, row.id);
  const ratedAxes = new Set(content.ratings.map((r) => r.axis));
  const missingAxes = RATING_AXES.filter((a) => !ratedAxes.has(a));

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
    semanticSteps: content.semanticSteps.map((s) => ({
      semanticStepIndex: s.semanticStepIndex,
      chapterNumber: chapterNumbers.get(s.semanticStepIndex) ?? null,
      title: s.title,
      summary: s.summary,
      stepIndices: stepIndicesBySection.get(s.semanticStepIndex) ?? [],
    })),
    blocks: content.blocks.flatMap((b) => decodeBlock(b) ?? []),
    issues: content.issues.map(decodeIssue),
    ratings: content.ratings.map(decodeRating),
    comments: messages.map((m) => {
      const thread = threadById.get(m.threadId);
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
      missingInlineComments: missingComments,
      missingAxes,
    },
  };

  return ok(JSON.stringify(payload, null, 2));
};
