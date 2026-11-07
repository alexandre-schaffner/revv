import { createHash } from "node:crypto";
import type {
  ExternalAgentProvider,
  WalkthroughGenerationMode,
  WalkthroughStatus,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { commentThreads } from "../../db/schema/comment-threads";
import { reviewSessions } from "../../db/schema/review-sessions";
import { threadMessages } from "../../db/schema/thread-messages";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { NotFoundError } from "../../domain/errors";
import { type ExternalAgentScope, SHA_PATTERN } from "../../services/ExternalIntegrations";
import { threadWrites } from "../../services/Review";
import {
  decodeIssue,
  decodeStringArray,
  latestCompleteWalkthrough,
} from "../../services/walkthrough/content";
import type {
  WalkthroughRequestOutcome,
  WalkthroughRequestRefusal,
} from "../../services/walkthrough/request";
import {
  getWalkthroughForEditTool,
  updateBlockTool,
  updateIssueTool,
  updateOverviewTool,
  updateRatingTool,
  updateSemanticStepTool,
  updateSentimentTool,
} from "./chat-edit-tools";
import { runChatEdit } from "./chat-edit-tools/helpers";
import type { ChatWalkthroughEditContext } from "./chat-edit-tools/spec";
import { getReviewContextTool } from "./chat-mcp-tools";
import {
  defineTool,
  fail,
  type McpToolResult,
  ok,
  type ToolSpec,
  type ToolSpecBundle,
} from "./mcp-tool-gateway";

export interface ExternalReviewToolContext extends ChatWalkthroughEditContext {
  readonly integrationId: string;
  /** Which external agent is calling; stamped on every write it authors. */
  readonly provider: ExternalAgentProvider;
  /** Display name of {@link provider}, used as the reply author name. */
  readonly providerName: string;
  readonly prHeadSha: string | null;
  readonly pushReply: (messageId: string) => Promise<void>;
  readonly pushStatus: (threadId: string) => Promise<void>;
  /** Start (or join) generation through the orchestrator; see `walkthrough-request.ts`. */
  readonly requestWalkthrough: (input: {
    readonly headSha: string;
    readonly generationMode: WalkthroughGenerationMode;
  }) => Promise<WalkthroughRequestOutcome>;
  /** How often `wait_for_walkthrough` re-reads the row; tests shorten it. */
  readonly walkthroughPollMs?: number;
}

type ExternalReviewToolSpec = ToolSpec<ExternalReviewToolContext, McpToolResult> & {
  readonly scope: ExternalAgentScope;
};

function scoped(
  spec: ToolSpec<ChatWalkthroughEditContext, McpToolResult>,
  scope: ExternalAgentScope,
): ExternalReviewToolSpec {
  return { ...spec, scope };
}

const tool = defineTool<ExternalReviewToolContext>();

/** Normalized to lowercase so it compares equal to the SHAs Revv stores. */
const shaSchema = z.string().regex(SHA_PATTERN).toLowerCase();

function canonicalEvidence(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

const recordIssueResolutionSchema = z
  .object({
    issue_id: z.string().min(1),
    expected_head_sha: shaSchema,
    status: z.enum(["open", "addressed", "wont_fix"]),
    explanation: z.string().trim().min(1).nullable(),
    evidence: z.array(z.string().trim().min(1)).max(20),
    resolving_commit_sha: shaSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status !== "open" && value.explanation === null) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "required when resolved" });
    }
    if (value.status !== "open" && value.evidence.length === 0) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: "required when resolved" });
    }
  });

const recordIssueResolutionSpec = scoped(
  tool({
    name: "record_issue_resolution",
    access: "write",
    description:
      "Record verified local implementation state for a Revv issue. Idempotent for an identical payload. Submitted GitHub issues are immutable; resolve their linked thread instead.",
    inputSchema: recordIssueResolutionSchema,
    handler: async (ctx, parsed) => {
      return runChatEdit(ctx, (wt) => {
        if (parsed.expected_head_sha !== wt.prHeadSha) {
          return {
            refused: `Stale review context: expected reviewed head ${parsed.expected_head_sha}, current walkthrough head ${wt.prHeadSha}. Call get_review_context again.`,
          };
        }
        const issue = ctx.db
          .select()
          .from(walkthroughIssues)
          .where(
            and(
              eq(walkthroughIssues.id, parsed.issue_id),
              eq(walkthroughIssues.walkthroughId, wt.id),
            ),
          )
          .get();
        if (!issue) {
          return {
            refused: `Issue '${parsed.issue_id}' does not exist in the active walkthrough.`,
          };
        }
        if (issue.submittedAt !== null) {
          return {
            refused: `Issue '${issue.title}' was submitted to GitHub and is immutable. Address and resolve its linked comment thread instead.`,
          };
        }

        const evidence = parsed.status === "open" ? [] : canonicalEvidence(parsed.evidence);
        const explanation = parsed.status === "open" ? null : parsed.explanation;
        const resolvingCommitSha = parsed.status === "open" ? null : parsed.resolving_commit_sha;
        if (
          issue.resolutionStatus === parsed.status &&
          issue.resolutionExplanation === explanation &&
          JSON.stringify(canonicalEvidence(decodeStringArray(issue.resolutionEvidence))) ===
            JSON.stringify(evidence) &&
          issue.resolvingCommitSha === resolvingCommitSha
        ) {
          return {
            unchanged: true,
            message: `Issue ${parsed.issue_id} already has that resolution.`,
          };
        }

        const resolution = {
          resolutionStatus: parsed.status,
          resolutionExplanation: explanation,
          resolutionEvidence: JSON.stringify(evidence),
          resolvingCommitSha,
          resolvedAt: parsed.status === "open" ? null : new Date().toISOString(),
          resolvedBy: parsed.status === "open" ? null : ctx.provider,
        };
        ctx.db
          .update(walkthroughIssues)
          .set(resolution)
          .where(eq(walkthroughIssues.id, issue.id))
          .run();
        return {
          message: `Issue ${parsed.issue_id} is now ${parsed.status}.`,
          events: [{ type: "issue", data: decodeIssue({ ...issue, ...resolution }) }],
        };
      });
    },
  }),
  "issues:resolve",
);

function threadForPr(ctx: ExternalReviewToolContext, threadId: string) {
  return ctx.db
    .select({ thread: commentThreads, prId: reviewSessions.pullRequestId })
    .from(commentThreads)
    .innerJoin(reviewSessions, eq(commentThreads.reviewSessionId, reviewSessions.id))
    .where(and(eq(commentThreads.id, threadId), eq(reviewSessions.pullRequestId, ctx.prId)))
    .get();
}

function replyId(integrationId: string, threadId: string, idempotencyKey: string): string {
  // The integration id already identifies the provider account, so the digest
  // stays stable across reconnects of the same integration row.
  return `external:${createHash("sha256")
    .update(`${integrationId}\0${threadId}\0${idempotencyKey}`)
    .digest("hex")}`;
}

const replyToCommentSchema = z.object({
  thread_id: z.string().min(1),
  expected_head_sha: shaSchema,
  body: z.string().trim().min(1).max(65_536),
  idempotency_key: z.string().trim().min(8).max(200),
  publish_to_github: z.boolean(),
});

const replyToCommentSpec = scoped(
  tool({
    name: "reply_to_comment",
    access: "write",
    description:
      "Add an idempotent coder reply to a Revv review thread. publish_to_github must be chosen explicitly; retries with the same key never duplicate the local reply.",
    inputSchema: replyToCommentSchema,
    handler: async (ctx, parsed) => {
      const reviewedHeadSha =
        latestCompleteWalkthrough(ctx.db, ctx.prId)?.prHeadSha ?? ctx.prHeadSha;
      if (reviewedHeadSha === null || parsed.expected_head_sha !== reviewedHeadSha) {
        return fail("The PR head changed. Refresh review context before replying.");
      }
      const located = threadForPr(ctx, parsed.thread_id);
      if (!located) return fail(`Thread '${parsed.thread_id}' is not part of this PR.`);

      const id = replyId(ctx.integrationId, parsed.thread_id, parsed.idempotency_key);
      const recorded = ctx.db.select().from(threadMessages).where(eq(threadMessages.id, id)).get();
      if (recorded && (recorded.threadId !== parsed.thread_id || recorded.body !== parsed.body)) {
        return fail(
          "That idempotency_key was already used with different reply content. Use a new key.",
        );
      }
      let message = recorded;
      if (!message) {
        const written = ctx.db.transaction((tx) =>
          threadWrites.reply(
            tx,
            parsed.thread_id,
            {
              authorRole: "coder",
              authorName: ctx.providerName,
              body: parsed.body,
              messageType: "reply",
            },
            id,
          ),
        );
        if (written instanceof NotFoundError) return fail(`Thread '${parsed.thread_id}' is gone.`);
        for (const envelope of written.envelopes) ctx.broadcastThreadEvent(envelope);
        message = ctx.db.select().from(threadMessages).where(eq(threadMessages.id, id)).get();
      }
      if (!message) return fail("Reply was not persisted.");
      const inserted = recorded === undefined;

      if (parsed.publish_to_github && message.externalId === null) {
        try {
          await ctx.pushReply(message.id);
        } catch (error) {
          return fail(
            `Reply saved in Revv, but GitHub publishing failed: ${error instanceof Error ? error.message : String(error)}. Retry with the same idempotency_key.`,
          );
        }
      }
      return ok(
        `${inserted ? "Reply added" : "Reply already recorded"}${parsed.publish_to_github ? " and synchronized with GitHub" : " locally"}.`,
      );
    },
  }),
  "comments:write",
);

const updateCommentStatusSchema = z.object({
  thread_id: z.string().min(1),
  expected_head_sha: shaSchema,
  status: z.enum(["open", "pending_coder", "pending_reviewer", "resolved", "wont_fix"]),
  publish_to_github: z.boolean(),
});

const updateCommentStatusSpec = scoped(
  tool({
    name: "update_comment_status",
    access: "write",
    description:
      "Set a review thread to open, pending_coder, pending_reviewer, resolved, or wont_fix. The local write is idempotent; GitHub synchronization can be retried.",
    inputSchema: updateCommentStatusSchema,
    handler: async (ctx, parsed) => {
      const reviewedHeadSha =
        latestCompleteWalkthrough(ctx.db, ctx.prId)?.prHeadSha ?? ctx.prHeadSha;
      if (reviewedHeadSha === null || parsed.expected_head_sha !== reviewedHeadSha) {
        return fail("The PR head changed. Refresh review context before changing thread status.");
      }
      const located = threadForPr(ctx, parsed.thread_id);
      if (!located) return fail(`Thread '${parsed.thread_id}' is not part of this PR.`);

      const written = ctx.db.transaction((tx) =>
        threadWrites.setStatus(tx, parsed.thread_id, parsed.status),
      );
      if (written instanceof NotFoundError) return fail(`Thread '${parsed.thread_id}' is gone.`);
      for (const envelope of written.envelopes) ctx.broadcastThreadEvent(envelope);
      const changed = written.envelopes.length > 0;
      if (parsed.publish_to_github) {
        if (located.thread.externalThreadId === null) {
          return fail(
            "Thread status saved in Revv, but this thread has no GitHub thread id to synchronize. Sync comments in Revv and retry the same call.",
          );
        }
        try {
          await ctx.pushStatus(parsed.thread_id);
        } catch (error) {
          return fail(
            `Thread status saved in Revv, but GitHub synchronization failed: ${error instanceof Error ? error.message : String(error)}. Retry the same call.`,
          );
        }
      }
      return ok(
        `Thread ${parsed.thread_id} ${changed ? `set to ${parsed.status}` : `was already ${parsed.status}`}${parsed.publish_to_github ? " and synchronized with GitHub" : " locally"}.`,
      );
    },
  }),
  "comments:write",
);

const requestWalkthroughSchema = z.object({
  head_sha: shaSchema,
  generation_mode: z.enum(["incremental", "full"]).default("incremental"),
});

function describeRefusal(outcome: WalkthroughRequestRefusal, requestedHeadSha: string): string {
  switch (outcome.kind) {
    case "head_mismatch":
      return `GitHub reports the PR head as ${outcome.githubHeadSha}, not ${requestedHeadSha}. Push your commits, then retry; GitHub can take a few seconds to serve a fresh push.`;
    case "stopped_by_user":
      return `The user stopped Revv's review of ${requestedHeadSha} (walkthrough ${outcome.walkthroughId}). Don't retry; tell the user, who can restart it from Revv.`;
    case "budget_exhausted":
      return outcome.scope === "head"
        ? `Revv has already run ${outcome.runs} reviews of ${requestedHeadSha} without one completing. Don't retry; report this to the user.`
        : `Revv has started ${outcome.runs} reviews of this PR in the last hour. Don't retry now; report this to the user.`;
  }
}

const requestWalkthroughSpec = scoped(
  tool({
    name: "request_walkthrough",
    access: "write",
    description:
      "Ask Revv to review the PR at head_sha: the commit you just pushed (`git rev-parse HEAD`). Push first — Revv reviews what GitHub serves. Returns a walkthroughId at once; generation takes minutes, so pass it to wait_for_walkthrough. Idempotent per head: a finished review of that head is returned instead of a new run, and a run in progress is joined. Refuses to restart a run the user stopped, and refuses once a head or PR has used its run budget. generation_mode 'incremental' (default) reviews the commits since the last review and re-checks its findings; 'full' re-reviews the whole PR.",
    inputSchema: requestWalkthroughSchema,
    handler: async (ctx, parsed) => {
      let outcome: WalkthroughRequestOutcome;
      try {
        outcome = await ctx.requestWalkthrough({
          headSha: parsed.head_sha,
          generationMode: parsed.generation_mode,
        });
      } catch (error) {
        return fail(
          `Revv could not start the walkthrough: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        outcome.kind === "head_mismatch" ||
        outcome.kind === "stopped_by_user" ||
        outcome.kind === "budget_exhausted"
      ) {
        return fail(describeRefusal(outcome, parsed.head_sha));
      }
      return ok(
        JSON.stringify(
          {
            outcome: outcome.kind,
            walkthroughId: outcome.walkthroughId,
            headSha: outcome.headSha,
            mode: outcome.mode,
            next:
              outcome.kind === "already_complete"
                ? "Call get_review_context to read this review."
                : "Call wait_for_walkthrough with this walkthroughId until its status is no longer 'generating'.",
          },
          null,
          2,
        ),
      );
    },
  }),
  "walkthrough:generate",
);

/**
 * Under the 60 s tool-call timeout some clients default to (Codex), and so
 * under the bridge's 120 s request budget too — the bridge is single-lane, so
 * a wait the client abandons still holds it.
 */
export const MAX_WAIT_SECONDS = 50;
const DEFAULT_WAIT_POLL_MS = 2_000;

const waitForWalkthroughSchema = z.object({
  walkthrough_id: z.string().min(1),
  timeout_seconds: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(40),
});

const WAIT_NEXT_STEP: Record<WalkthroughStatus, string> = {
  generating: "Still generating. Call wait_for_walkthrough again.",
  complete: "Call get_review_context to read the findings.",
  error:
    "Generation failed, or the user stopped it in Revv. Retry with request_walkthrough at the same head_sha only if the error looks transient; Revv refuses to restart a run the user stopped.",
  superseded:
    "A newer head replaced this review. Call request_walkthrough for the head you want reviewed.",
};

function walkthroughForPr(ctx: ExternalReviewToolContext, walkthroughId: string) {
  return ctx.db
    .select()
    .from(walkthroughs)
    .where(and(eq(walkthroughs.id, walkthroughId), eq(walkthroughs.pullRequestId, ctx.prId)))
    .get();
}

function summarizeIssues(ctx: ExternalReviewToolContext, walkthroughId: string) {
  const issues = ctx.db
    .select({
      severity: walkthroughIssues.severity,
      resolutionStatus: walkthroughIssues.resolutionStatus,
    })
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, walkthroughId))
    .all();
  const bySeverity: Record<string, number> = {};
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  }
  return {
    total: issues.length,
    open: issues.filter((issue) => issue.resolutionStatus === "open").length,
    bySeverity,
  };
}

const waitForWalkthroughSpec = scoped(
  tool({
    name: "wait_for_walkthrough",
    access: "read",
    description: `Wait up to timeout_seconds (default 40, max ${MAX_WAIT_SECONDS} — keep it under your client's tool-call timeout) for a walkthrough from request_walkthrough to leave 'generating', then report its status. Safe to call repeatedly. When complete, it summarizes the findings by severity; read them with get_review_context.`,
    inputSchema: waitForWalkthroughSchema,
    handler: async (ctx, parsed) => {
      const pollMs = ctx.walkthroughPollMs ?? DEFAULT_WAIT_POLL_MS;
      const deadline = Date.now() + parsed.timeout_seconds * 1000;
      let row = walkthroughForPr(ctx, parsed.walkthrough_id);
      while (row?.status === "generating" && Date.now() < deadline) {
        await Bun.sleep(Math.min(pollMs, deadline - Date.now()));
        row = walkthroughForPr(ctx, parsed.walkthrough_id);
      }
      if (!row) return fail(`Walkthrough '${parsed.walkthrough_id}' is not part of this PR.`);

      return ok(
        JSON.stringify(
          {
            walkthroughId: row.id,
            status: row.status,
            lastCompletedPhase: row.lastCompletedPhase,
            reviewedHeadSha: row.prHeadSha,
            generationMode: row.generationMode,
            ...(row.status === "error" ? { error: row.errorMessage } : {}),
            ...(row.status === "complete"
              ? { riskLevel: row.riskLevel, issues: summarizeIssues(ctx, row.id) }
              : {}),
            next: WAIT_NEXT_STEP[row.status],
          },
          null,
          2,
        ),
      );
    },
  }),
  "context:read",
);

export const EXTERNAL_REVIEW_TOOL_SPECS: ReadonlyArray<ExternalReviewToolSpec> = [
  scoped(getReviewContextTool, "context:read"),
  scoped(getWalkthroughForEditTool, "context:read"),
  scoped(updateOverviewTool, "walkthrough:edit"),
  scoped(updateSemanticStepTool, "walkthrough:edit"),
  scoped(updateBlockTool, "walkthrough:edit"),
  scoped(updateSentimentTool, "walkthrough:edit"),
  scoped(updateRatingTool, "walkthrough:edit"),
  scoped(updateIssueTool, "walkthrough:edit"),
  recordIssueResolutionSpec,
  replyToCommentSpec,
  updateCommentStatusSpec,
  requestWalkthroughSpec,
  waitForWalkthroughSpec,
];

export const EXTERNAL_REVIEW_TOOL_BUNDLE: ToolSpecBundle<ExternalReviewToolContext, McpToolResult> =
  {
    name: "revv-review",
    version: "1.0.0",
    route: "/mcp/external",
    specs: EXTERNAL_REVIEW_TOOL_SPECS,
  };

const SCOPE_BY_TOOL = new Map(EXTERNAL_REVIEW_TOOL_SPECS.map((spec) => [spec.name, spec.scope]));

export function hasExternalToolScope(name: string, scopes: readonly ExternalAgentScope[]): boolean {
  const required = SCOPE_BY_TOOL.get(name);
  return required !== undefined && scopes.includes(required);
}
