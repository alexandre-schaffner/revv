// The chat agent's MCP tools: `get_review_context` (here) and the chat-edit
// tools (`chat-edit-tools/`), invariant 7's post-completion mutation path.

import { chapterNumbersByIndex } from "@revv/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { commentThreads } from "../../db/schema/comment-threads";
import { pullRequests } from "../../db/schema/pull-requests";
import { repositories } from "../../db/schema/repositories";
import { reviewSessions } from "../../db/schema/review-sessions";
import { threadMessages } from "../../db/schema/thread-messages";
import type { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import {
  blockOrder,
  decodeBlock,
  decodeIssue,
  decodeRating,
  decodeStringArray,
  latestCompleteWalkthrough,
  loadContentRows,
  loadIssueThreads,
} from "../../services/walkthrough/content";
import { EDIT_TOOL_SPECS } from "./chat-edit-tools";
import type { ChatEditToolHandler, ChatWalkthroughEditContext } from "./chat-edit-tools/spec";
import { defineTool, fail, type McpToolResult, ok, type ToolSpecBundle } from "./mcp-tool-gateway";

interface ParsedBlock {
  readonly orderIndex: number;
  readonly type: string;
  readonly content: string;
  readonly filePath: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

function parseBlock(row: typeof walkthroughBlocks.$inferSelect): ParsedBlock {
  const block = decodeBlock(row);
  const at = {
    orderIndex: blockOrder(row.semanticStepIndex, row.stepIndex),
    type: row.type,
  };
  const unanchored = { filePath: null, startLine: null, endLine: null };
  switch (block?.type) {
    case "markdown":
      return { ...at, ...unanchored, content: block.content };
    case "code":
      return {
        ...at,
        content: block.content,
        filePath: block.filePath,
        startLine: block.startLine,
        endLine: block.endLine,
      };
    case "diff":
      return { ...at, ...unanchored, content: block.patch, filePath: block.filePath };
    case "artifact": {
      // An artifact is a full HTML document (up to 256 KB) the chat agent
      // can't act on; keep the markup out of its context.
      const note = block.annotation?.trim();
      return {
        ...at,
        ...unanchored,
        content: note ? `[interactive artifact: ${note}]` : "[interactive artifact]",
      };
    }
    case undefined:
      return { ...at, ...unanchored, content: "" };
  }
}

const getReviewContextSchema = z.object({}).strict();

type GetReviewContextInput = z.infer<typeof getReviewContextSchema>;

const getReviewContextHandler: ChatEditToolHandler<GetReviewContextInput> = async (ctx) => {
  const { db, prId } = ctx;

  const prRow = db.select().from(pullRequests).where(eq(pullRequests.id, prId)).get();
  if (!prRow) {
    return fail(`PR not found: ${prId}`);
  }
  const repository = db
    .select()
    .from(repositories)
    .where(eq(repositories.id, prRow.repositoryId))
    .get();

  const walkthroughRow = latestCompleteWalkthrough(db, prId);
  const content = walkthroughRow
    ? loadContentRows(db, walkthroughRow.id)
    : { semanticSteps: [], blocks: [], issues: [], ratings: [] };
  const issueRows = content.issues;
  const blockRows = content.blocks;
  const blocksById = new Map(blockRows.map((b) => [b.id, b]));

  const { threads: linkedThreads, messages: linkedMessages } = loadIssueThreads(
    db,
    issueRows.map((i) => i.id),
  );
  const linkedMsgsByThread = new Map<string, (typeof linkedMessages)[number][]>();
  for (const m of linkedMessages) {
    const arr = linkedMsgsByThread.get(m.threadId) ?? [];
    arr.push(m);
    linkedMsgsByThread.set(m.threadId, arr);
  }
  const linkedThreadByIssue = new Map<string, (typeof linkedThreads)[number]>();
  for (const t of linkedThreads) {
    if (t.walkthroughIssueId) linkedThreadByIssue.set(t.walkthroughIssueId, t);
  }

  const standaloneThreads = db
    .select({ thread: commentThreads })
    .from(commentThreads)
    .innerJoin(reviewSessions, eq(reviewSessions.id, commentThreads.reviewSessionId))
    .where(and(eq(reviewSessions.pullRequestId, prId), isNull(commentThreads.walkthroughIssueId)))
    .all()
    .map((r) => r.thread);
  const standaloneIds = standaloneThreads.map((t) => t.id);
  const standaloneMessages =
    standaloneIds.length > 0
      ? db
          .select()
          .from(threadMessages)
          .where(inArray(threadMessages.threadId, standaloneIds))
          .orderBy(threadMessages.createdAt)
          .all()
      : [];
  const standaloneMsgsByThread = new Map<string, typeof standaloneMessages>();
  for (const m of standaloneMessages) {
    const arr = standaloneMsgsByThread.get(m.threadId) ?? [];
    arr.push(m);
    standaloneMsgsByThread.set(m.threadId, arr);
  }

  const chapterNumbers = chapterNumbersByIndex(
    content.semanticSteps.map((s) => s.semanticStepIndex),
    blockRows.map((b) => b.semanticStepIndex),
  );

  const payload = {
    pr: {
      id: prRow.id,
      number: prRow.externalId,
      url: prRow.url,
      repository: repository?.fullName ?? null,
      title: prRow.title,
      body: prRow.body,
      sourceBranch: prRow.sourceBranch,
      targetBranch: prRow.targetBranch,
      headSha: prRow.headSha,
    },
    walkthrough: walkthroughRow
      ? {
          id: walkthroughRow.id,
          reviewedHeadSha: walkthroughRow.prHeadSha,
          summary: walkthroughRow.summary,
          riskLevel: walkthroughRow.riskLevel,
          sentiment: walkthroughRow.sentiment,
          status: walkthroughRow.status,
          generatedAt: walkthroughRow.generatedAt,
          chapters: content.semanticSteps.map((semantic) => ({
            semanticStepIndex: semantic.semanticStepIndex,
            chapterNumber: chapterNumbers.get(semantic.semanticStepIndex) ?? null,
            title: semantic.title,
            summary: semantic.summary,
            blocks: blockRows
              .filter((block) => block.semanticStepIndex === semantic.semanticStepIndex)
              .map((block) => ({
                semanticStepIndex: block.semanticStepIndex,
                stepIndex: block.stepIndex,
                ...parseBlock(block),
              })),
          })),
          ratings: content.ratings.map(decodeRating),
        }
      : null,
    flaggedIssues: issueRows.map((issue) => {
      const blocks = decodeStringArray(issue.blockIds)
        .map((id) => blocksById.get(id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined)
        .map(parseBlock);
      const linked = linkedThreadByIssue.get(issue.id);
      const linkedMsgs = linked ? (linkedMsgsByThread.get(linked.id) ?? []) : [];
      const inlineComment = linked
        ? {
            body: linkedMsgs.map((m) => m.body).join("\n\n"),
            filePath: linked.filePath,
            startLine: linked.startLine,
            endLine: linked.endLine,
          }
        : null;
      const decodedIssue = decodeIssue(issue);
      return {
        id: issue.id,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        filePath: issue.filePath,
        startLine: issue.startLine,
        endLine: issue.endLine,
        submittedToGitHub: issue.submittedAt != null,
        resolutionStatus: decodedIssue.resolutionStatus ?? "open",
        resolutionExplanation: decodedIssue.resolutionExplanation ?? null,
        resolutionEvidence: decodedIssue.resolutionEvidence ?? [],
        resolvingCommitSha: decodedIssue.resolvingCommitSha ?? null,
        resolvedAt: decodedIssue.resolvedAt ?? null,
        resolvedBy: decodedIssue.resolvedBy ?? null,
        blocks,
        inlineComment: linked
          ? {
              threadId: linked.id,
              status: linked.status,
              filePath: linked.filePath,
              startLine: linked.startLine,
              endLine: linked.endLine,
              body: inlineComment?.body ?? "",
              messages: linkedMsgs.map((message) => ({
                id: message.id,
                role: message.authorRole,
                author: message.authorName,
                body: message.body,
                createdAt: message.createdAt,
                externalId: message.externalId,
              })),
            }
          : null,
      };
    }),
    reviewerComments: standaloneThreads.map((thread) => ({
      threadId: thread.id,
      filePath: thread.filePath,
      startLine: thread.startLine,
      endLine: thread.endLine,
      diffSide: thread.diffSide,
      status: thread.status,
      messages: (standaloneMsgsByThread.get(thread.id) ?? []).map((m) => ({
        id: m.id,
        role: m.authorRole,
        author: m.authorName,
        body: m.body,
        createdAt: m.createdAt,
        externalId: m.externalId,
      })),
    })),
  };

  return ok(JSON.stringify(payload, null, 2));
};

export const getReviewContextTool = defineTool<ChatWalkthroughEditContext>()({
  name: "get_review_context",
  access: "read",
  description:
    "Fetch the structured review context for the current PR — walkthrough analysis, all flagged issues (with their associated diff steps and inline review comments), and standalone reviewer comment threads. Returns a single JSON-stringified payload. Call this at the start of a conversation when the user asks you to address issues or comments, instead of grepping the worktree for them.",
  inputSchema: getReviewContextSchema,
  handler: getReviewContextHandler,
});

export const CHAT_TOOL_BUNDLE: ToolSpecBundle<ChatWalkthroughEditContext, McpToolResult> = {
  name: "revv-chat-context",
  version: "2.0.0",
  route: "/mcp/chat-context",
  specs: [getReviewContextTool, ...EDIT_TOOL_SPECS],
};
