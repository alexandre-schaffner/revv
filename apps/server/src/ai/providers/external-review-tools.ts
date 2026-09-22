import { createHash } from "node:crypto";
import type { ExternalAgentProvider, ThreadMessage, ThreadStatus } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { commentThreads } from "../../db/schema/comment-threads";
import { reviewSessions } from "../../db/schema/review-sessions";
import { threadMessages } from "../../db/schema/thread-messages";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import type { ExternalAgentScope } from "../../services/ExternalIntegrations";
import {
  assertStillComplete,
  decodeIssue,
  fail,
  ok,
  resolveActiveWalkthroughId,
  stampLastEdited,
} from "./chat-edit-tools/helpers";
import type { ChatToolContext, ChatToolResult, ChatToolSpec } from "./chat-mcp-tools";
import { CHAT_TOOL_SPECS } from "./chat-mcp-tools";
import type { ToolSpec, ToolSpecBundle } from "./mcp-tool-gateway";

const SHARED_EXTERNAL_TOOL_NAMES = new Set([
  "get_review_context",
  "get_walkthrough_for_edit",
  "update_overview",
  "update_semantic_step",
  "update_block",
  "update_sentiment",
  "update_rating",
  "update_issue",
]);

const READ_TOOL_NAMES = new Set(["get_review_context", "get_walkthrough_for_edit"]);

export interface ExternalReviewToolContext extends ChatToolContext {
  readonly integrationId: string;
  /** Which external agent is calling; stamped on every write it authors. */
  readonly provider: ExternalAgentProvider;
  /** Display name of {@link provider}, used as the reply author name. */
  readonly providerName: string;
  readonly prHeadSha: string | null;
  readonly pushReply: (messageId: string) => Promise<void>;
  readonly pushThreadStatus: (threadId: string) => Promise<void>;
}

export type ExternalReviewToolSpec = ToolSpec<ExternalReviewToolContext, ChatToolResult>;

function selectedSharedSpecs(): ExternalReviewToolSpec[] {
  return CHAT_TOOL_SPECS.filter((spec) => SHARED_EXTERNAL_TOOL_NAMES.has(spec.name)).map(
    (spec: ChatToolSpec): ExternalReviewToolSpec => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      handler: async (ctx, input) => {
        if (!READ_TOOL_NAMES.has(spec.name)) {
          const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
          if (!active || active.prHeadSha !== ctx.prHeadSha) {
            return fail(
              "The active completed walkthrough no longer matches this checkout's PR head. Refresh Revv and call get_review_context again before editing.",
            );
          }
        }
        return spec.handler(ctx, input);
      },
    }),
  );
}

function canonicalEvidence(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

const recordIssueResolutionSchema = z
  .object({
    issue_id: z.string().min(1),
    expected_head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
    status: z.enum(["open", "addressed", "wont_fix"]),
    explanation: z.string().trim().min(1).nullable(),
    evidence: z.array(z.string().trim().min(1)).max(20),
    resolving_commit_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status !== "open" && value.explanation === null) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "required when resolved" });
    }
    if (value.status !== "open" && value.evidence.length === 0) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: "required when resolved" });
    }
  });

const recordIssueResolutionSpec: ExternalReviewToolSpec = {
  name: "record_issue_resolution",
  description:
    "Record verified local implementation state for a Revv issue. Idempotent for an identical payload. Submitted GitHub issues are immutable; resolve their linked thread instead.",
  inputSchema: recordIssueResolutionSchema,
  handler: async (ctx, input) => {
    const parsed = recordIssueResolutionSchema.parse(input);
    if (ctx.prHeadSha === null || parsed.expected_head_sha !== ctx.prHeadSha) {
      return fail(
        `Stale review context: expected head ${parsed.expected_head_sha}, current Revv head ${ctx.prHeadSha ?? "unknown"}. Call get_review_context again.`,
      );
    }
    const active = resolveActiveWalkthroughId(ctx.db, ctx.prId);
    if (!active || active.prHeadSha !== ctx.prHeadSha) {
      return fail("No completed walkthrough matches the current PR head.");
    }

    let result: ChatToolResult | null = null;
    let eventIssue: ReturnType<typeof decodeIssue> | null = null;
    let unchanged = false;
    ctx.db.transaction(() => {
      const guarded = assertStillComplete(ctx.db, active.id);
      if ("error" in guarded) {
        result = fail(guarded.error);
        return;
      }
      const issue = ctx.db
        .select()
        .from(walkthroughIssues)
        .where(
          and(
            eq(walkthroughIssues.id, parsed.issue_id),
            eq(walkthroughIssues.walkthroughId, active.id),
          ),
        )
        .get();
      if (!issue) {
        result = fail(`Issue '${parsed.issue_id}' does not exist in the active walkthrough.`);
        return;
      }
      if (issue.submittedAt !== null) {
        result = fail(
          `Issue '${issue.title}' was submitted to GitHub and is immutable. Address and resolve its linked comment thread instead.`,
        );
        return;
      }

      const evidence = parsed.status === "open" ? [] : canonicalEvidence(parsed.evidence);
      const explanation = parsed.status === "open" ? null : parsed.explanation;
      const resolvingCommitSha = parsed.status === "open" ? null : parsed.resolving_commit_sha;
      let existingEvidence: string[] = [];
      try {
        const decoded: unknown = JSON.parse(issue.resolutionEvidence);
        if (Array.isArray(decoded)) existingEvidence = canonicalEvidence(decoded.filter(isString));
      } catch {
        // A rewrite below repairs corrupt metadata.
      }
      unchanged =
        issue.resolutionStatus === parsed.status &&
        issue.resolutionExplanation === explanation &&
        JSON.stringify(existingEvidence) === JSON.stringify(evidence) &&
        issue.resolvingCommitSha === resolvingCommitSha;
      if (unchanged) {
        eventIssue = decodeIssue(issue);
        return;
      }

      const resolvedAt = parsed.status === "open" ? null : new Date().toISOString();
      const resolvedBy = parsed.status === "open" ? null : ctx.provider;
      ctx.db
        .update(walkthroughIssues)
        .set({
          resolutionStatus: parsed.status,
          resolutionExplanation: explanation,
          resolutionEvidence: JSON.stringify(evidence),
          resolvingCommitSha,
          resolvedAt,
          resolvedBy,
        })
        .where(eq(walkthroughIssues.id, issue.id))
        .run();
      stampLastEdited(ctx.db, active.id, ctx.actor);
      eventIssue = decodeIssue({
        ...issue,
        resolutionStatus: parsed.status,
        resolutionExplanation: explanation,
        resolutionEvidence: JSON.stringify(evidence),
        resolvingCommitSha,
        resolvedAt,
        resolvedBy,
      });
    });
    if (result) return result;
    if (!eventIssue) return fail("Issue resolution was not persisted.");
    if (!unchanged) ctx.emit(active.id, { type: "issue", data: eventIssue });
    return ok(
      unchanged
        ? `Issue ${parsed.issue_id} already has that resolution.`
        : `Issue ${parsed.issue_id} is now ${parsed.status}.`,
    );
  },
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

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
  expected_head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  body: z.string().trim().min(1).max(65_536),
  idempotency_key: z.string().trim().min(8).max(200),
  publish_to_github: z.boolean(),
});

const replyToCommentSpec: ExternalReviewToolSpec = {
  name: "reply_to_comment",
  description:
    "Add an idempotent coder reply to a Revv review thread. publish_to_github must be chosen explicitly; retries with the same key never duplicate the local reply.",
  inputSchema: replyToCommentSchema,
  handler: async (ctx, input) => {
    const parsed = replyToCommentSchema.parse(input);
    if (ctx.prHeadSha === null || parsed.expected_head_sha !== ctx.prHeadSha) {
      return fail("The PR head changed. Refresh review context before replying.");
    }
    const located = threadForPr(ctx, parsed.thread_id);
    if (!located) return fail(`Thread '${parsed.thread_id}' is not part of this PR.`);

    const id = replyId(ctx.integrationId, parsed.thread_id, parsed.idempotency_key);
    let message = ctx.db.select().from(threadMessages).where(eq(threadMessages.id, id)).get();
    let newStatus: ThreadStatus | null = null;
    let inserted = false;
    if (message) {
      if (message.threadId !== parsed.thread_id || message.body !== parsed.body) {
        return fail(
          "That idempotency_key was already used with different reply content. Use a new key.",
        );
      }
    } else {
      const createdAt = new Date().toISOString();
      ctx.db.transaction(() => {
        ctx.db
          .insert(threadMessages)
          .values({
            id,
            threadId: parsed.thread_id,
            authorRole: "coder",
            authorName: ctx.providerName,
            body: parsed.body,
            messageType: "reply",
            createdAt,
          })
          .run();
        if (located.thread.status !== "resolved" && located.thread.status !== "wont_fix") {
          newStatus = "pending_reviewer";
          ctx.db
            .update(commentThreads)
            .set({ status: newStatus, resolvedAt: null })
            .where(eq(commentThreads.id, parsed.thread_id))
            .run();
        }
      });
      message = ctx.db.select().from(threadMessages).where(eq(threadMessages.id, id)).get();
      inserted = true;
    }
    if (!message) return fail("Reply was not persisted.");

    const eventMessage: ThreadMessage = {
      id: message.id,
      threadId: message.threadId,
      authorRole: "coder",
      authorName: message.authorName,
      authorLogin: message.authorLogin ?? null,
      authorAvatarContent: null,
      body: message.body,
      messageType: "reply",
      codeSuggestion: message.codeSuggestion ?? null,
      createdAt: message.createdAt,
      editedAt: message.editedAt ?? null,
      externalId: message.externalId ?? null,
    };
    if (inserted) {
      ctx.broadcastThreadEvent({
        type: "thread:message",
        data: { threadId: parsed.thread_id, message: eventMessage },
      });
      if (newStatus) {
        ctx.broadcastThreadEvent({
          type: "thread:updated",
          data: { threadId: parsed.thread_id, status: newStatus },
        });
      }
    }

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
};

const updateCommentStatusSchema = z.object({
  thread_id: z.string().min(1),
  expected_head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  status: z.enum(["open", "pending_coder", "pending_reviewer", "resolved", "wont_fix"]),
  publish_to_github: z.boolean(),
});

const updateCommentStatusSpec: ExternalReviewToolSpec = {
  name: "update_comment_status",
  description:
    "Set a review thread to open, pending_coder, pending_reviewer, resolved, or wont_fix. The local write is idempotent; GitHub synchronization can be retried.",
  inputSchema: updateCommentStatusSchema,
  handler: async (ctx, input) => {
    const parsed = updateCommentStatusSchema.parse(input);
    if (ctx.prHeadSha === null || parsed.expected_head_sha !== ctx.prHeadSha) {
      return fail("The PR head changed. Refresh review context before changing thread status.");
    }
    const located = threadForPr(ctx, parsed.thread_id);
    if (!located) return fail(`Thread '${parsed.thread_id}' is not part of this PR.`);

    const changed = located.thread.status !== parsed.status;
    if (changed) {
      const terminal = parsed.status === "resolved" || parsed.status === "wont_fix";
      ctx.db
        .update(commentThreads)
        .set({
          status: parsed.status,
          resolvedAt: terminal ? new Date().toISOString() : null,
        })
        .where(eq(commentThreads.id, parsed.thread_id))
        .run();
      ctx.broadcastThreadEvent({
        type: "thread:updated",
        data: { threadId: parsed.thread_id, status: parsed.status },
      });
    }
    if (parsed.publish_to_github) {
      if (located.thread.externalThreadId === null) {
        return fail(
          "Thread status saved in Revv, but this thread has no GitHub thread id to synchronize. Sync comments in Revv and retry the same call.",
        );
      }
      try {
        await ctx.pushThreadStatus(parsed.thread_id);
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
};

export const EXTERNAL_REVIEW_TOOL_SPECS: ReadonlyArray<ExternalReviewToolSpec> = [
  ...selectedSharedSpecs(),
  recordIssueResolutionSpec,
  replyToCommentSpec,
  updateCommentStatusSpec,
];

export const EXTERNAL_REVIEW_TOOL_BUNDLE: ToolSpecBundle<
  ExternalReviewToolContext,
  ChatToolResult
> = {
  name: "revv-review",
  version: "1.0.0",
  specs: EXTERNAL_REVIEW_TOOL_SPECS,
};

const TOOL_SCOPE: Readonly<Record<string, ExternalAgentScope>> = {
  get_review_context: "context:read",
  get_walkthrough_for_edit: "context:read",
  update_overview: "walkthrough:edit",
  update_semantic_step: "walkthrough:edit",
  update_block: "walkthrough:edit",
  update_sentiment: "walkthrough:edit",
  update_rating: "walkthrough:edit",
  update_issue: "walkthrough:edit",
  record_issue_resolution: "issues:resolve",
  reply_to_comment: "comments:write",
  update_comment_status: "comments:write",
};

export function scopeForExternalTool(name: string): ExternalAgentScope | null {
  return TOOL_SCOPE[name] ?? null;
}

export function hasExternalToolScope(name: string, scopes: readonly ExternalAgentScope[]): boolean {
  const required = scopeForExternalTool(name);
  return required !== null && scopes.includes(required);
}
