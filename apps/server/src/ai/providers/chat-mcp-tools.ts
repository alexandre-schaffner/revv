// ── chat-mcp-tools ──────────────────────────────────────────────────────────
//
// MCP tools for the right-pane chat agent. Spans two functional surfaces:
//   - READ: `get_review_context` (this file) — structured review context fetch.
//   - WRITE: walkthrough-edit tools (see `chat-edit-tools.ts`) — the chat
//     agent's authorized post-completion mutation path (CLAUDE.md invariant
//     #7 carve-out).
//
// Per doctrine invariant #13 (agent-path parity), handler implementations
// are shared across both transports (in-process Claude SDK + HTTP MCP for
// opencode). The factory below produces a Claude-SDK-shaped server bound
// to a single context; the HTTP route in `routes/mcp/chat-context.ts`
// drives the same TOOL_SPECS with a per-request context.

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { commentThreads } from "../../db/schema/comment-threads";
import { pullRequests } from "../../db/schema/pull-requests";
import { reviewSessions } from "../../db/schema/review-sessions";
import { threadMessages } from "../../db/schema/thread-messages";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../db/schema/walkthroughs";
import type { ChatEditToolResult, ChatWalkthroughEditContext } from "./chat-edit-tools";
import { EDIT_TOOL_SPECS } from "./chat-edit-tools";
import { bindInProcess, type ToolSpec, type ToolSpecBundle } from "./mcp-tool-gateway";

// ── Context ─────────────────────────────────────────────────────────────────

/**
 * Unified chat-MCP execution context. Carries the read-only essentials
 * (`db`, `prId`) plus the edit-tool fields (`userId`, `actor`, `emit`,
 * `broadcastThreadEvent`). Read-only handlers ignore the extras. Both
 * transports inject this before dispatching:
 *
 *   - Claude SDK: bound at server-creation time via {@link createChatMcpServer}.
 *   - opencode HTTP: bound per-request after resolving the bearer token in
 *     `routes/mcp/chat-context.ts`.
 */
export type ChatToolContext = ChatWalkthroughEditContext;

export type ChatToolResult = ChatEditToolResult;

export type ChatToolHandler<TInput> = (
  ctx: ChatToolContext,
  args: TInput,
) => Promise<ChatToolResult>;

export type ChatToolSpec = ToolSpec<ChatToolContext, ChatToolResult>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(text: string): ChatToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string): ChatToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

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
    case "artifact":
      content = str("html");
      break;
    default:
      content = JSON.stringify(parsed);
  }
  // Synthesize a stable monotonic order from the composite key
  // (semanticStepIndex, stepIndex) — used by chat tool consumers that want
  // to display blocks in walkthrough render order.
  return {
    orderIndex: row.semanticStepIndex * 10000 + row.stepIndex,
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

const getReviewContextHandler: ChatToolHandler<GetReviewContextInput> = async (ctx) => {
  const { db, prId } = ctx;

  const prRow = db.select().from(pullRequests).where(eq(pullRequests.id, prId)).get();
  if (!prRow) {
    return fail(`PR not found: ${prId}`);
  }

  // Latest completed walkthrough for this PR (ordered by generatedAt desc).
  const walkthroughRow = db
    .select()
    .from(walkthroughs)
    .where(and(eq(walkthroughs.pullRequestId, prId), eq(walkthroughs.status, "complete")))
    .orderBy(desc(walkthroughs.generatedAt))
    .limit(1)
    .get();

  const issueRows = walkthroughRow
    ? db
        .select()
        .from(walkthroughIssues)
        .where(eq(walkthroughIssues.walkthroughId, walkthroughRow.id))
        .orderBy(walkthroughIssues.order)
        .all()
    : [];

  // Pre-load all blocks for the walkthrough — we'll fan out to per-issue
  // blockIds without N+1 queries.
  const blockRows = walkthroughRow
    ? db
        .select()
        .from(walkthroughBlocks)
        .where(eq(walkthroughBlocks.walkthroughId, walkthroughRow.id))
        .orderBy(walkthroughBlocks.semanticStepIndex, walkthroughBlocks.stepIndex)
        .all()
    : [];
  const blocksById = new Map(blockRows.map((b) => [b.id, b]));

  // Inline review comments authored by the agent via `add_issue_comment` are
  // linked back to the issue via comment_threads.walkthroughIssueId. Fetch
  // all of them in one go.
  const issueIds = issueRows.map((i) => i.id);
  const linkedThreads =
    issueIds.length > 0
      ? db
          .select()
          .from(commentThreads)
          .where(inArray(commentThreads.walkthroughIssueId, issueIds))
          .all()
      : [];
  const linkedThreadIds = linkedThreads.map((t) => t.id);
  const linkedMessages =
    linkedThreadIds.length > 0
      ? db
          .select()
          .from(threadMessages)
          .where(inArray(threadMessages.threadId, linkedThreadIds))
          .orderBy(threadMessages.createdAt)
          .all()
      : [];
  const linkedMsgsByThread = new Map<string, typeof linkedMessages>();
  for (const m of linkedMessages) {
    const arr = linkedMsgsByThread.get(m.threadId) ?? [];
    arr.push(m);
    linkedMsgsByThread.set(m.threadId, arr);
  }
  const linkedThreadByIssue = new Map<string, (typeof linkedThreads)[number]>();
  for (const t of linkedThreads) {
    if (t.walkthroughIssueId) linkedThreadByIssue.set(t.walkthroughIssueId, t);
  }

  // Standalone reviewer comments — every comment thread on this PR's active
  // review session that ISN'T linked to a walkthrough issue.
  const session = db
    .select()
    .from(reviewSessions)
    .where(and(eq(reviewSessions.pullRequestId, prId), eq(reviewSessions.status, "active")))
    .limit(1)
    .get();

  const allThreadsForSession = session
    ? db.select().from(commentThreads).where(eq(commentThreads.reviewSessionId, session.id)).all()
    : [];
  const standaloneThreads = allThreadsForSession.filter((t) => t.walkthroughIssueId == null);
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

  // Build the structured payload. We return JSON-stringified text so the
  // agent can reason over it (and callers don't have to JSON-parse a result
  // shape outside of `content`).
  const payload = {
    pr: {
      title: prRow.title,
      body: prRow.body,
      sourceBranch: prRow.sourceBranch,
      targetBranch: prRow.targetBranch,
      headSha: prRow.headSha,
    },
    walkthrough: walkthroughRow
      ? {
          summary: walkthroughRow.summary,
          riskLevel: walkthroughRow.riskLevel,
          sentiment: walkthroughRow.sentiment,
          status: walkthroughRow.status,
          generatedAt: walkthroughRow.generatedAt,
        }
      : null,
    flaggedIssues: issueRows.map((issue) => {
      let blockIds: string[] = [];
      try {
        const v = JSON.parse(issue.blockIds) as unknown;
        if (Array.isArray(v)) blockIds = v.filter((x): x is string => typeof x === "string");
      } catch {
        /* corrupt JSON */
      }
      const blocks = blockIds
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
      return {
        id: issue.id,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        filePath: issue.filePath,
        startLine: issue.startLine,
        endLine: issue.endLine,
        submittedToGitHub: issue.submittedAt != null,
        blocks,
        inlineComment,
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
        role: m.authorRole,
        author: m.authorName,
        body: m.body,
        createdAt: m.createdAt,
      })),
    })),
  };

  return ok(JSON.stringify(payload, null, 2));
};

// ── Tool registry ───────────────────────────────────────────────────────────

export const CHAT_TOOL_SPECS: ReadonlyArray<ChatToolSpec> = [
  {
    name: "get_review_context",
    description:
      "Fetch the structured review context for the current PR — walkthrough analysis, all flagged issues (with their associated diff steps and inline review comments), and standalone reviewer comment threads. Returns a single JSON-stringified payload. Call this at the start of a conversation when the user asks you to address issues or comments, instead of grepping the worktree for them.",
    inputSchema: getReviewContextSchema,
    handler: getReviewContextHandler,
  },
  // Walkthrough-edit tools (CLAUDE.md invariant #7 chat-edit carve-out).
  // These mutate the latest completed walkthrough for the PR; they never
  // touch status / lastCompletedPhase. See `chat-edit-tools.ts` for
  // handler implementations.
  ...EDIT_TOOL_SPECS,
];

export const CHAT_TOOL_BUNDLE: ToolSpecBundle<ChatToolContext, ChatToolResult> = {
  name: "revv-chat-context",
  version: "1.0.0",
  specs: CHAT_TOOL_SPECS,
};

// ── Claude Agent SDK adapter ────────────────────────────────────────────────

/**
 * Create an in-process MCP server registration for the Claude Agent SDK,
 * scoped to a single PR. Mirrors `createWalkthroughMcpServer` but with the
 * read-only tool surface above.
 */
export function createChatMcpServer(ctx: ChatToolContext): ReturnType<typeof bindInProcess> {
  return bindInProcess(CHAT_TOOL_BUNDLE, ctx);
}
