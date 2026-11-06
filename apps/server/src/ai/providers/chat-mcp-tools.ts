// ── chat-mcp-tools ──────────────────────────────────────────────────────────
//
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
  decodeIssue,
  decodeRating,
  decodeStringArray,
  latestCompleteWalkthrough,
  loadContentRows,
  loadIssueThreads,
} from "../../services/walkthrough/content";
import { EDIT_TOOL_SPECS } from "./chat-edit-tools";
import type {
  ChatEditToolHandler,
  ChatEditToolSpecRecord,
  ChatWalkthroughEditContext,
} from "./chat-edit-tools/spec";
import type { McpToolResult, ToolSpecBundle } from "./mcp-tool-gateway";
import { fail, ok } from "./mcp-tool-gateway";

interface ParsedBlock {
  readonly orderIndex: number;
  readonly type: string;
  readonly content: string;
  readonly filePath: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

/**
 * Parse the `data` JSON column of a walkthrough_blocks row into a stable
 * shape suitable for the agent. Best-effort — corrupt JSON falls back to
 * "type:unknown content:''".
 */
function parseBlock(row: typeof walkthroughBlocks.$inferSelect): ParsedBlock {
  let parsed: Record<string, unknown> = {};
  try {
    const v = JSON.parse(row.data) as unknown;
    if (v && typeof v === "object") {
      parsed = v as Record<string, unknown>;
    }
  } catch {
    /* corrupt JSON */
  }
  const str = (k: string): string => (typeof parsed[k] === "string" ? (parsed[k] as string) : "");
  const num = (k: string): number | null =>
    typeof parsed[k] === "number" ? (parsed[k] as number) : null;
  let content = "";
  switch (row.type) {
    case "markdown":
      content = str("content");
      break;
    case "code":
      content = str("content");
      break;
    case "diff":
      content = str("patch");
      break;
    case "artifact": {
      // An artifact is a full HTML document (up to 256 KB) the chat agent
      // can't act on; surface a compact placeholder plus the human-readable
      // annotation instead of dumping the verbatim markup into its context.
      const note = str("annotation").trim();
      content = note ? `[interactive artifact: ${note}]` : "[interactive artifact]";
      break;
    }
    default:
      content = JSON.stringify(parsed);
  }
  return {
    orderIndex: blockOrder(row.semanticStepIndex, row.stepIndex),
    type: row.type,
    content,
    filePath: typeof parsed.filePath === "string" ? (parsed.filePath as string) : null,
    startLine: num("startLine"),
    endLine: num("endLine"),
  };
}

// ── Tool: get_review_context ────────────────────────────────────────────────

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

  // Standalone reviewer comments: every comment thread on this PR that isn't
  // linked to a walkthrough issue.
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

  // Build the structured payload. We return JSON-stringified text so the
  // agent can reason over it (and callers don't have to JSON-parse a result
  // shape outside of `content`).
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

// ── Tool registry ───────────────────────────────────────────────────────────

export const CHAT_TOOL_SPECS: ReadonlyArray<ChatEditToolSpecRecord> = [
  {
    name: "get_review_context",
    description:
      "Fetch the structured review context for the current PR — walkthrough analysis, all flagged issues (with their associated diff steps and inline review comments), and standalone reviewer comment threads. Returns a single JSON-stringified payload. Call this at the start of a conversation when the user asks you to address issues or comments, instead of grepping the worktree for them.",
    inputSchema: getReviewContextSchema,
    handler: getReviewContextHandler,
  },
  ...EDIT_TOOL_SPECS,
];

export const CHAT_TOOL_BUNDLE: ToolSpecBundle<ChatWalkthroughEditContext, McpToolResult> = {
  name: "revv-chat-context",
  version: "1.0.0",
  specs: CHAT_TOOL_SPECS,
};
