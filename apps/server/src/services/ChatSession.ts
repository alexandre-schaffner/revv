// ── ChatSession ────────────────────────────────────────────────────────────
//
// Drizzle wrapper around chat persistence: `chat_sessions` (the durable
// thread handle) plus `chat_messages` and `chat_activities` (the transcript
// + structured tool-use rows added in migration 0110).
//
// Two responsibilities:
//
//   1. Session bookkeeping — find/upsert/clear per (prId, agent, model, prHeadSha),
//      patch in the agent-side session id once the SDK / daemon emits it.
//   2. Transcript persistence — append user messages, stream assistant
//      content into a single row, append typed activity rows. All inserts
//      atomically allocate `chat_sessions.next_sequence` so messages and
//      activities share one monotonic ordering space.
//
// Session sequence allocation runs inside a SQLite transaction so concurrent
// turns (which shouldn't happen for the same PR but could during retries)
// can't double-issue the same sequence number.

import type { ChatTask, InteractionMode, NormalizedQuestion } from "@revv/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  chatActivities,
  chatMessages,
  chatPlans,
  chatQuestions,
  chatSessions,
  chatSubagentInvocations,
  chatTasks,
} from "../db/schema/index";
import { DbService } from "./Db";

export interface ChatSessionRow {
  readonly id: string;
  readonly pullRequestId: string;
  readonly agent: string;
  readonly model: string;
  readonly sessionId: string | null;
  readonly prHeadSha: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly nextSequence: number;
  readonly interactionMode: InteractionMode;
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

export interface FindOrCreateChatSessionParams {
  readonly prId: string;
  readonly agent: string;
  readonly model: string;
  readonly prHeadSha: string;
  readonly worktreePath: string;
  readonly branchName: string;
}

export interface UpsertChatSessionParams {
  readonly prId: string;
  readonly agent: string;
  readonly model: string;
  readonly prHeadSha: string;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly branchName: string;
}

export interface ChatMessageRow {
  readonly id: string;
  readonly chatSessionId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly isStreaming: boolean;
  readonly sequence: number;
  readonly turnId: string;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
}

export interface ChatActivityRow {
  readonly id: string;
  readonly chatSessionId: string;
  readonly turnId: string;
  readonly activityKind: string;
  readonly toolName: string | null;
  readonly summary: string;
  readonly payloadJson: string | null;
  readonly sequence: number;
  readonly subagentInvocationId: string | null;
  readonly createdAt: string;
}

export interface ChatTaskRow {
  readonly id: string;
  readonly chatSessionId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly content: string;
  readonly activeForm: string | null;
  readonly status: "pending" | "in_progress" | "completed";
  readonly priority: "low" | "medium" | "high" | null;
  readonly source: "acp";
  readonly sequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChatPlanRow {
  readonly id: string;
  readonly chatSessionId: string;
  readonly turnId: string;
  readonly planMarkdown: string;
  readonly status: "pending" | "approved" | "rejected" | "superseded";
  readonly source: "acp";
  readonly sequence: number;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface ChatSubagentInvocationRow {
  readonly id: string;
  readonly chatSessionId: string;
  readonly parentTurnId: string;
  readonly providerCallId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly prompt: string;
  readonly status: "running" | "completed" | "errored";
  readonly result: string | null;
  readonly source: "acp";
  readonly sequence: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface ChatQuestionRow {
  readonly id: string;
  readonly chatSessionId: string;
  readonly turnId: string;
  readonly source: "acp";
  readonly providerRequestId: string;
  readonly providerToolCallId: string | null;
  readonly previewFormat: "markdown" | "html";
  readonly questions: ReadonlyArray<NormalizedQuestion>;
  readonly status: "pending" | "answered" | "rejected" | "superseded";
  readonly answers: Readonly<Record<string, ReadonlyArray<string>>> | null;
  readonly customAnswers: Readonly<Record<string, string>> | null;
  readonly sequence: number;
  readonly createdAt: string;
  readonly answeredAt: string | null;
}

/**
 * One synthetic timeline entry for a turn's task list. Aggregated server-side
 * because tasks land as N rows but the UI renders as one section.
 */
export interface ChatTaskListTimelineEntry {
  readonly entryKind: "task-list";
  readonly turnId: string;
  readonly sequence: number;
  readonly tasks: ReadonlyArray<ChatTask>;
}

export type ChatTimelineEntry =
  | (ChatMessageRow & { readonly entryKind: "message" })
  | (ChatActivityRow & { readonly entryKind: "activity" })
  | ChatTaskListTimelineEntry
  | (ChatPlanRow & { readonly entryKind: "plan" })
  | (ChatSubagentInvocationRow & { readonly entryKind: "subagent" })
  | (ChatQuestionRow & { readonly entryKind: "question" });

export class ChatSessionService extends Context.Tag("ChatSessionService")<
  ChatSessionService,
  {
    readonly find: (
      prId: string,
      agent: string,
      model: string,
      prHeadSha: string,
    ) => Effect.Effect<ChatSessionRow | null>;
    /**
     * Find the most recently active chat session for a PR+agent pair,
     * regardless of prHeadSha. Used by commit-management endpoints where the
     * worktree may be on an old SHA.
     */
    readonly findLatestForPr: (prId: string, agent: string) => Effect.Effect<ChatSessionRow | null>;
    /**
     * Look up the existing row for (prId, agent, model, prHeadSha) or insert a
     * fresh one with `session_id = NULL`. Used by the chat route at the
     * START of a turn so subsequent message/activity inserts can FK to
     * the row before the agent emits its session id (which arrives
     * mid-stream).
     */
    readonly findOrCreate: (params: FindOrCreateChatSessionParams) => Effect.Effect<ChatSessionRow>;
    /**
     * Patch the agent-side session id (and refresh worktree/branch which
     * stay informational) onto an existing row. Called from the route's
     * `onSessionId` callback.
     */
    readonly setAgentSessionId: (params: {
      readonly chatSessionId: string;
      readonly sessionId: string;
      readonly worktreePath: string;
      readonly branchName: string;
    }) => Effect.Effect<void>;
    readonly upsert: (params: UpsertChatSessionParams) => Effect.Effect<void>;
    /**
     * Update the prHeadSha of an existing session row. Called by the
     * merge-and-push flow after a successful push so the session lookup
     * (keyed on `(prId, agent, model, prHeadSha)`) keeps finding this conversation
     * even after `pull_requests.headSha` advances to the freshly pushed tip.
     */
    readonly updatePrHeadSha: (params: {
      readonly chatSessionId: string;
      readonly prHeadSha: string;
    }) => Effect.Effect<void>;
    readonly clear: (
      prId: string,
      agent: string,
      model: string,
      prHeadSha: string,
    ) => Effect.Effect<void>;
    readonly clearAllForPr: (prId: string, agent: string) => Effect.Effect<void>;
    readonly clearAllForAgent: (agent: string) => Effect.Effect<void>;

    /**
     * Insert a finalized user message. Returns the row's id + the
     * allocated sequence (which the caller may include in outgoing SSE
     * frames once B3 lands).
     */
    readonly appendUserMessage: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly content: string;
    }) => Effect.Effect<{ readonly id: string; readonly sequence: number }>;

    /**
     * Insert a streaming assistant placeholder. `is_streaming = 1`,
     * empty content. The route appends content via
     * `appendAssistantContent` and finalizes via `finalizeAssistantMessage`.
     */
    readonly beginAssistantMessage: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
    }) => Effect.Effect<{ readonly id: string; readonly sequence: number }>;

    /** Append `chunk` to the assistant message body in-place. */
    readonly appendAssistantContent: (params: {
      readonly messageId: string;
      readonly chunk: string;
    }) => Effect.Effect<void>;

    /**
     * Mark the assistant message as no-longer-streaming. If `error` is
     * set, the inline-error chip text persists for renders that follow.
     */
    readonly finalizeAssistantMessage: (params: {
      readonly messageId: string;
      readonly error?: string | null;
    }) => Effect.Effect<void>;

    readonly appendActivity: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly activityKind: string;
      readonly toolName: string | null;
      readonly summary: string;
      readonly payload?: unknown;
      readonly subagentInvocationId?: string | null;
    }) => Effect.Effect<{ readonly id: string; readonly sequence: number }>;

    /** Read the full timeline for a session, ordered by sequence. */
    readonly listTimeline: (chatSessionId: string) => Effect.Effect<readonly ChatTimelineEntry[]>;

    // ── interaction mode ────────────────────────────────────────────────

    readonly setInteractionMode: (params: {
      readonly chatSessionId: string;
      readonly mode: InteractionMode;
    }) => Effect.Effect<void>;

    // ── tasks ───────────────────────────────────────────────────────────

    /**
     * Reconcile a full task-list snapshot. Existing rows matched by
     * `(chat_session_id, task_id)` are updated in place (preserving their
     * sequence); previously-unseen tasks are inserted at fresh
     * sequences. Rows missing from the snapshot are left alone (v1
     * decision; reconsider if drift becomes an issue).
     */
    readonly applyTaskListSnapshot: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly source: "acp";
      readonly tasks: ReadonlyArray<ChatTask>;
    }) => Effect.Effect<readonly ChatTaskRow[]>;

    readonly listTasks: (chatSessionId: string) => Effect.Effect<readonly ChatTaskRow[]>;

    // ── plans ───────────────────────────────────────────────────────────

    /**
     * Insert a new plan in `pending` status. Throws if a plan already
     * exists for this turn (unique constraint).
     */
    readonly createPlan: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly source: "acp";
      readonly markdown: string;
    }) => Effect.Effect<ChatPlanRow>;

    readonly decidePlan: (params: {
      readonly planId: string;
      readonly decision: "approved" | "rejected" | "superseded";
    }) => Effect.Effect<ChatPlanRow | null>;

    readonly findPlan: (planId: string) => Effect.Effect<ChatPlanRow | null>;

    readonly findPendingPlan: (chatSessionId: string) => Effect.Effect<ChatPlanRow | null>;

    // ── sub-agents ──────────────────────────────────────────────────────

    readonly startSubagentInvocation: (params: {
      readonly chatSessionId: string;
      readonly parentTurnId: string;
      readonly source: "acp";
      readonly providerCallId: string;
      readonly subagentType: string;
      readonly description: string;
      readonly prompt: string;
    }) => Effect.Effect<{
      readonly invocationId: string;
      readonly sequence: number;
    }>;

    readonly completeSubagentInvocation: (params: {
      readonly invocationId: string;
      readonly result: string;
      readonly ok: boolean;
    }) => Effect.Effect<void>;

    readonly findSubagentInvocationByProviderId: (params: {
      readonly chatSessionId: string;
      readonly providerCallId: string;
    }) => Effect.Effect<ChatSubagentInvocationRow | null>;

    // ── questions ──────────────────────────────────────────────────────

    /**
     * Insert a new question prompt in `pending` status. Idempotent on
     * `(chat_session_id, provider_request_id)` — re-emitting the same
     * provider request returns the existing row unchanged.
     */
    readonly createQuestion: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly source: "acp";
      readonly providerRequestId: string;
      readonly providerToolCallId?: string | null;
      readonly previewFormat: "markdown" | "html";
      readonly questions: ReadonlyArray<NormalizedQuestion>;
    }) => Effect.Effect<ChatQuestionRow>;

    /**
     * Flip the question's status. Idempotent: if the row is already in a
     * terminal state (anything other than 'pending'), this is a no-op
     * and returns the existing row unchanged. Used by both the user's
     * answer endpoint and the agent stream's resolution follow-up —
     * whichever runs second hits the no-op path.
     */
    readonly decideQuestion: (params: {
      readonly questionId: string;
      readonly status: "answered" | "rejected" | "superseded";
      readonly answers?: Readonly<Record<string, ReadonlyArray<string>>>;
      readonly customAnswers?: Readonly<Record<string, string>>;
    }) => Effect.Effect<ChatQuestionRow | null>;

    readonly findQuestion: (questionId: string) => Effect.Effect<ChatQuestionRow | null>;

    readonly findPendingQuestion: (chatSessionId: string) => Effect.Effect<ChatQuestionRow | null>;

    /**
     * On boot, mark every pending question as `superseded`. Their
     * in-memory deferreds are gone and the agent run that issued them
     * has died — re-asking is the only recovery path.
     */
    readonly supersedePendingQuestionsOnBoot: () => Effect.Effect<number>;
  }
>() {}

const nowIso = (): string => new Date().toISOString();

export const ChatSessionServiceLive = Layer.effect(
  ChatSessionService,
  Effect.gen(function* () {
    const { db } = yield* DbService;

    // Atomically allocate the next sequence number for a session. Wrapped
    // in a transaction so two concurrent turns (which shouldn't happen for
    // the same PR, but might during retries) can't double-issue the same
    // number — the unique index would catch it but a transaction is cheaper.
    const allocateSequence = (chatSessionId: string): number =>
      db.transaction((tx) => {
        const row = tx
          .select({ next: chatSessions.nextSequence })
          .from(chatSessions)
          .where(eq(chatSessions.id, chatSessionId))
          .get();
        if (!row) {
          throw new Error(
            `chat_sessions row ${chatSessionId} disappeared during sequence allocation`,
          );
        }
        const seq = row.next;
        tx.update(chatSessions)
          .set({ nextSequence: seq + 1, lastActivityAt: nowIso() })
          .where(eq(chatSessions.id, chatSessionId))
          .run();
        return seq;
      });

    const rowToSessionRow = (row: typeof chatSessions.$inferSelect): ChatSessionRow => ({
      id: row.id,
      pullRequestId: row.pullRequestId,
      agent: row.agent,
      model: row.model,
      sessionId: row.sessionId,
      prHeadSha: row.prHeadSha,
      worktreePath: row.worktreePath,
      branchName: row.branchName,
      nextSequence: row.nextSequence,
      interactionMode: row.interactionMode === "plan" ? "plan" : "default",
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
    });

    const rowToTaskRow = (row: typeof chatTasks.$inferSelect): ChatTaskRow => ({
      id: row.id,
      chatSessionId: row.chatSessionId,
      turnId: row.turnId,
      taskId: row.taskId,
      content: row.content,
      activeForm: row.activeForm,
      status: row.status as ChatTaskRow["status"],
      priority: (row.priority as ChatTaskRow["priority"]) ?? null,
      source: row.source as ChatTaskRow["source"],
      sequence: row.sequence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

    const rowToPlanRow = (row: typeof chatPlans.$inferSelect): ChatPlanRow => ({
      id: row.id,
      chatSessionId: row.chatSessionId,
      turnId: row.turnId,
      planMarkdown: row.planMarkdown,
      status: row.status as ChatPlanRow["status"],
      source: row.source as ChatPlanRow["source"],
      sequence: row.sequence,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    });

    const rowToQuestionRow = (row: typeof chatQuestions.$inferSelect): ChatQuestionRow => {
      let parsedQuestions: ReadonlyArray<NormalizedQuestion> = [];
      try {
        parsedQuestions = JSON.parse(row.questionsJson) as ReadonlyArray<NormalizedQuestion>;
      } catch {
        // Corrupt JSON — render as an empty list rather than crashing the
        // timeline. This should never happen in practice; the column is
        // only ever populated via JSON.stringify in createQuestion.
        parsedQuestions = [];
      }
      let parsedAnswers: Readonly<Record<string, ReadonlyArray<string>>> | null = null;
      if (row.answersJson) {
        try {
          parsedAnswers = JSON.parse(row.answersJson) as Record<string, ReadonlyArray<string>>;
        } catch {
          parsedAnswers = null;
        }
      }
      let parsedCustom: Readonly<Record<string, string>> | null = null;
      if (row.customAnswersJson) {
        try {
          parsedCustom = JSON.parse(row.customAnswersJson) as Record<string, string>;
        } catch {
          parsedCustom = null;
        }
      }
      return {
        id: row.id,
        chatSessionId: row.chatSessionId,
        turnId: row.turnId,
        source: row.source as ChatQuestionRow["source"],
        providerRequestId: row.providerRequestId,
        providerToolCallId: row.providerToolCallId,
        previewFormat: row.previewFormat === "html" ? "html" : "markdown",
        questions: parsedQuestions,
        status: row.status as ChatQuestionRow["status"],
        answers: parsedAnswers,
        customAnswers: parsedCustom,
        sequence: row.sequence,
        createdAt: row.createdAt,
        answeredAt: row.answeredAt,
      };
    };

    const rowToSubagentRow = (
      row: typeof chatSubagentInvocations.$inferSelect,
    ): ChatSubagentInvocationRow => ({
      id: row.id,
      chatSessionId: row.chatSessionId,
      parentTurnId: row.parentTurnId,
      providerCallId: row.providerCallId,
      subagentType: row.subagentType,
      description: row.description,
      prompt: row.prompt,
      status: row.status as ChatSubagentInvocationRow["status"],
      result: row.result,
      source: row.source as ChatSubagentInvocationRow["source"],
      sequence: row.sequence,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    });

    return {
      find: (prId, agent, model, prHeadSha) =>
        Effect.sync(() => {
          const row = db
            .select()
            .from(chatSessions)
            .where(
              and(
                eq(chatSessions.pullRequestId, prId),
                eq(chatSessions.agent, agent),
                eq(chatSessions.model, model),
                eq(chatSessions.prHeadSha, prHeadSha),
              ),
            )
            .get();
          return row ? rowToSessionRow(row) : null;
        }),

      findLatestForPr: (prId, agent) =>
        Effect.sync(() => {
          const row = db
            .select()
            .from(chatSessions)
            .where(and(eq(chatSessions.pullRequestId, prId), eq(chatSessions.agent, agent)))
            .orderBy(desc(chatSessions.lastActivityAt))
            .limit(1)
            .get();
          return row ? rowToSessionRow(row) : null;
        }),

      findOrCreate: ({ prId, agent, model, prHeadSha, worktreePath, branchName }) =>
        Effect.sync(() => {
          const existing = db
            .select()
            .from(chatSessions)
            .where(
              and(
                eq(chatSessions.pullRequestId, prId),
                eq(chatSessions.agent, agent),
                eq(chatSessions.model, model),
                eq(chatSessions.prHeadSha, prHeadSha),
              ),
            )
            .get();
          if (existing) {
            // Refresh worktree/branch in case the PR's worktree was
            // reseated to a new path. Cheap.
            if (existing.worktreePath !== worktreePath || existing.branchName !== branchName) {
              db.update(chatSessions)
                .set({ worktreePath, branchName, lastActivityAt: nowIso() })
                .where(eq(chatSessions.id, existing.id))
                .run();
              existing.worktreePath = worktreePath;
              existing.branchName = branchName;
            }
            return rowToSessionRow(existing);
          }
          const id = crypto.randomUUID();
          const now = nowIso();
          db.insert(chatSessions)
            .values({
              id,
              pullRequestId: prId,
              agent,
              model,
              sessionId: null,
              prHeadSha,
              worktreePath,
              branchName,
              nextSequence: 0,
              interactionMode: "default",
              createdAt: now,
              lastActivityAt: now,
            })
            .run();
          return {
            id,
            pullRequestId: prId,
            agent,
            model,
            sessionId: null,
            prHeadSha,
            worktreePath,
            branchName,
            nextSequence: 0,
            interactionMode: "default" as InteractionMode,
            createdAt: now,
            lastActivityAt: now,
          };
        }),

      setAgentSessionId: ({ chatSessionId, sessionId, worktreePath, branchName }) =>
        Effect.sync(() => {
          db.update(chatSessions)
            .set({
              sessionId,
              worktreePath,
              branchName,
              lastActivityAt: nowIso(),
            })
            .where(eq(chatSessions.id, chatSessionId))
            .run();
        }),

      updatePrHeadSha: ({ chatSessionId, prHeadSha }) =>
        Effect.sync(() => {
          db.update(chatSessions)
            .set({ prHeadSha, lastActivityAt: nowIso() })
            .where(eq(chatSessions.id, chatSessionId))
            .run();
        }),

      upsert: ({ prId, agent, model, prHeadSha, sessionId, worktreePath, branchName }) =>
        Effect.sync(() => {
          const now = nowIso();
          db.insert(chatSessions)
            .values({
              id: crypto.randomUUID(),
              pullRequestId: prId,
              agent,
              model,
              sessionId,
              prHeadSha,
              worktreePath,
              branchName,
              nextSequence: 0,
              interactionMode: "default",
              createdAt: now,
              lastActivityAt: now,
            })
            .onConflictDoUpdate({
              target: [
                chatSessions.pullRequestId,
                chatSessions.agent,
                chatSessions.model,
                chatSessions.prHeadSha,
              ],
              set: {
                sessionId,
                worktreePath,
                branchName,
                lastActivityAt: now,
              },
            })
            .run();
        }),

      clear: (prId, agent, model, prHeadSha) =>
        Effect.sync(() => {
          db.delete(chatSessions)
            .where(
              and(
                eq(chatSessions.pullRequestId, prId),
                eq(chatSessions.agent, agent),
                eq(chatSessions.model, model),
                eq(chatSessions.prHeadSha, prHeadSha),
              ),
            )
            .run();
        }),

      clearAllForPr: (prId, agent) =>
        Effect.sync(() => {
          db.delete(chatSessions)
            .where(and(eq(chatSessions.pullRequestId, prId), eq(chatSessions.agent, agent)))
            .run();
        }),

      clearAllForAgent: (agent) =>
        Effect.sync(() => {
          db.delete(chatSessions).where(eq(chatSessions.agent, agent)).run();
        }),

      appendUserMessage: ({ chatSessionId, turnId, content }) =>
        Effect.sync(() => {
          const sequence = allocateSequence(chatSessionId);
          const id = crypto.randomUUID();
          const now = nowIso();
          db.insert(chatMessages)
            .values({
              id,
              chatSessionId,
              role: "user",
              content,
              isStreaming: 0,
              sequence,
              turnId,
              error: null,
              createdAt: now,
              finalizedAt: now,
            })
            .run();
          return { id, sequence };
        }),

      beginAssistantMessage: ({ chatSessionId, turnId }) =>
        Effect.sync(() => {
          const sequence = allocateSequence(chatSessionId);
          const id = crypto.randomUUID();
          const now = nowIso();
          db.insert(chatMessages)
            .values({
              id,
              chatSessionId,
              role: "assistant",
              content: "",
              isStreaming: 1,
              sequence,
              turnId,
              error: null,
              createdAt: now,
              finalizedAt: null,
            })
            .run();
          return { id, sequence };
        }),

      appendAssistantContent: ({ messageId, chunk }) =>
        Effect.sync(() => {
          if (chunk.length === 0) return;
          // SQL `||` concat — atomic and cheap. Avoids a read-modify-
          // write race if two stream callbacks ever interleaved.
          db.run(
            sql`UPDATE chat_messages SET content = content || ${chunk} WHERE id = ${messageId}`,
          );
        }),

      finalizeAssistantMessage: ({ messageId, error }) =>
        Effect.sync(() => {
          db.update(chatMessages)
            .set({
              isStreaming: 0,
              finalizedAt: nowIso(),
              error: error ?? null,
            })
            .where(eq(chatMessages.id, messageId))
            .run();
        }),

      appendActivity: ({
        chatSessionId,
        turnId,
        activityKind,
        toolName,
        summary,
        payload,
        subagentInvocationId,
      }) =>
        Effect.sync(() => {
          const sequence = allocateSequence(chatSessionId);
          const id = crypto.randomUUID();
          const now = nowIso();
          db.insert(chatActivities)
            .values({
              id,
              chatSessionId,
              turnId,
              activityKind,
              toolName: toolName ?? null,
              summary,
              payloadJson: payload === undefined ? null : JSON.stringify(payload),
              sequence,
              subagentInvocationId: subagentInvocationId ?? null,
              createdAt: now,
            })
            .run();
          return { id, sequence };
        }),

      listTimeline: (chatSessionId) =>
        Effect.sync(() => {
          const messages = db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.chatSessionId, chatSessionId))
            .orderBy(asc(chatMessages.sequence))
            .all();
          const activities = db
            .select()
            .from(chatActivities)
            .where(eq(chatActivities.chatSessionId, chatSessionId))
            .orderBy(asc(chatActivities.sequence))
            .all();
          const plans = db
            .select()
            .from(chatPlans)
            .where(eq(chatPlans.chatSessionId, chatSessionId))
            .orderBy(asc(chatPlans.sequence))
            .all();
          const subagents = db
            .select()
            .from(chatSubagentInvocations)
            .where(eq(chatSubagentInvocations.chatSessionId, chatSessionId))
            .orderBy(asc(chatSubagentInvocations.sequence))
            .all();
          const questions = db
            .select()
            .from(chatQuestions)
            .where(eq(chatQuestions.chatSessionId, chatSessionId))
            .orderBy(asc(chatQuestions.sequence))
            .all();
          const taskRows = db
            .select()
            .from(chatTasks)
            .where(eq(chatTasks.chatSessionId, chatSessionId))
            .orderBy(asc(chatTasks.sequence))
            .all();

          // Bucket tasks by turn — the UI renders one TaskList per
          // turn. Each bucket lands at the minimum sequence of its
          // member tasks so the list appears at the right spot in
          // the interleaved timeline.
          const taskBuckets = new Map<string, { sequence: number; rows: ChatTaskRow[] }>();
          for (const r of taskRows) {
            const row = rowToTaskRow(r);
            const existing = taskBuckets.get(row.turnId);
            if (existing) {
              existing.sequence = Math.min(existing.sequence, row.sequence);
              existing.rows.push(row);
            } else {
              taskBuckets.set(row.turnId, {
                sequence: row.sequence,
                rows: [row],
              });
            }
          }
          const taskEntries: ChatTaskListTimelineEntry[] = [];
          for (const [turnId, bucket] of taskBuckets) {
            bucket.rows.sort((a, b) => a.sequence - b.sequence);
            taskEntries.push({
              entryKind: "task-list",
              turnId,
              sequence: bucket.sequence,
              tasks: bucket.rows.map(
                (r): ChatTask => ({
                  id: r.id,
                  content: r.content,
                  activeForm: r.activeForm,
                  status: r.status,
                  priority: r.priority,
                }),
              ),
            });
          }

          // k-way merge by sequence. Build a flat list of entries
          // with their sequence, sort, and emit. This is simpler
          // than 5-pointer streaming and the data volume is tiny.
          const entries: Array<{
            sequence: number;
            entry: ChatTimelineEntry;
          }> = [];
          for (const m of messages) {
            entries.push({
              sequence: m.sequence,
              entry: {
                entryKind: "message",
                id: m.id,
                chatSessionId: m.chatSessionId,
                role: m.role as "user" | "assistant",
                content: m.content,
                isStreaming: m.isStreaming === 1,
                sequence: m.sequence,
                turnId: m.turnId,
                error: m.error,
                createdAt: m.createdAt,
                finalizedAt: m.finalizedAt,
              },
            });
          }
          for (const a of activities) {
            entries.push({
              sequence: a.sequence,
              entry: {
                entryKind: "activity",
                id: a.id,
                chatSessionId: a.chatSessionId,
                turnId: a.turnId,
                activityKind: a.activityKind,
                toolName: a.toolName,
                summary: a.summary,
                payloadJson: a.payloadJson,
                sequence: a.sequence,
                subagentInvocationId: a.subagentInvocationId,
                createdAt: a.createdAt,
              },
            });
          }
          for (const p of plans) {
            entries.push({
              sequence: p.sequence,
              entry: { ...rowToPlanRow(p), entryKind: "plan" },
            });
          }
          for (const s of subagents) {
            entries.push({
              sequence: s.sequence,
              entry: { ...rowToSubagentRow(s), entryKind: "subagent" },
            });
          }
          for (const q of questions) {
            entries.push({
              sequence: q.sequence,
              entry: { ...rowToQuestionRow(q), entryKind: "question" },
            });
          }
          for (const t of taskEntries) {
            entries.push({ sequence: t.sequence, entry: t });
          }
          entries.sort((a, b) => a.sequence - b.sequence);
          return entries.map((e) => e.entry);
        }),

      // ── interaction mode ───────────────────────────────────────

      setInteractionMode: ({ chatSessionId, mode }) =>
        Effect.sync(() => {
          db.update(chatSessions)
            .set({ interactionMode: mode, lastActivityAt: nowIso() })
            .where(eq(chatSessions.id, chatSessionId))
            .run();
        }),

      // ── tasks ──────────────────────────────────────────────────

      applyTaskListSnapshot: ({ chatSessionId, turnId, source, tasks }) =>
        Effect.sync(() => {
          const result: ChatTaskRow[] = [];
          db.transaction((tx) => {
            const now = nowIso();
            const existing = tx
              .select()
              .from(chatTasks)
              .where(eq(chatTasks.chatSessionId, chatSessionId))
              .all();
            const byTaskId = new Map<string, (typeof existing)[number]>();
            for (const e of existing) byTaskId.set(e.taskId, e);

            for (const task of tasks) {
              const prior = byTaskId.get(task.id);
              if (prior) {
                // Update in place; preserve sequence.
                tx.update(chatTasks)
                  .set({
                    content: task.content,
                    activeForm: task.activeForm,
                    status: task.status,
                    priority: task.priority,
                    updatedAt: now,
                    // Track which turn most recently touched it.
                    turnId,
                    source,
                  })
                  .where(eq(chatTasks.id, prior.id))
                  .run();
                result.push({
                  ...rowToTaskRow(prior),
                  content: task.content,
                  activeForm: task.activeForm,
                  status: task.status,
                  priority: task.priority,
                  updatedAt: now,
                  turnId,
                  source,
                });
              } else {
                // New task — allocate sequence atomically.
                const seqRow = tx
                  .select({ next: chatSessions.nextSequence })
                  .from(chatSessions)
                  .where(eq(chatSessions.id, chatSessionId))
                  .get();
                if (!seqRow) {
                  throw new Error(
                    `chat_sessions row ${chatSessionId} disappeared during task insert`,
                  );
                }
                const sequence = seqRow.next;
                tx.update(chatSessions)
                  .set({
                    nextSequence: sequence + 1,
                    lastActivityAt: now,
                  })
                  .where(eq(chatSessions.id, chatSessionId))
                  .run();
                const id = crypto.randomUUID();
                tx.insert(chatTasks)
                  .values({
                    id,
                    chatSessionId,
                    turnId,
                    taskId: task.id,
                    content: task.content,
                    activeForm: task.activeForm,
                    status: task.status,
                    priority: task.priority,
                    source,
                    sequence,
                    createdAt: now,
                    updatedAt: now,
                  })
                  .run();
                result.push({
                  id,
                  chatSessionId,
                  turnId,
                  taskId: task.id,
                  content: task.content,
                  activeForm: task.activeForm,
                  status: task.status,
                  priority: task.priority,
                  source,
                  sequence,
                  createdAt: now,
                  updatedAt: now,
                });
              }
            }
          });
          return result;
        }),

      listTasks: (chatSessionId) =>
        Effect.sync(() => {
          return db
            .select()
            .from(chatTasks)
            .where(eq(chatTasks.chatSessionId, chatSessionId))
            .orderBy(asc(chatTasks.sequence))
            .all()
            .map(rowToTaskRow);
        }),

      // ── plans ──────────────────────────────────────────────────

      createPlan: ({ chatSessionId, turnId, source, markdown }) =>
        Effect.sync(() => {
          const id = crypto.randomUUID();
          const now = nowIso();
          let row: ChatPlanRow | null = null;
          db.transaction((tx) => {
            const seqRow = tx
              .select({ next: chatSessions.nextSequence })
              .from(chatSessions)
              .where(eq(chatSessions.id, chatSessionId))
              .get();
            if (!seqRow) {
              throw new Error(`chat_sessions row ${chatSessionId} disappeared during plan insert`);
            }
            const sequence = seqRow.next;
            tx.update(chatSessions)
              .set({
                nextSequence: sequence + 1,
                lastActivityAt: now,
              })
              .where(eq(chatSessions.id, chatSessionId))
              .run();
            tx.insert(chatPlans)
              .values({
                id,
                chatSessionId,
                turnId,
                planMarkdown: markdown,
                status: "pending",
                source,
                sequence,
                createdAt: now,
                decidedAt: null,
              })
              .run();
            row = {
              id,
              chatSessionId,
              turnId,
              planMarkdown: markdown,
              status: "pending",
              source,
              sequence,
              createdAt: now,
              decidedAt: null,
            };
          });
          if (!row) {
            throw new Error("createPlan transaction did not assign row");
          }
          return row;
        }),

      decidePlan: ({ planId, decision }) =>
        Effect.sync(() => {
          const now = nowIso();
          db.update(chatPlans)
            .set({ status: decision, decidedAt: now })
            .where(eq(chatPlans.id, planId))
            .run();
          const row = db.select().from(chatPlans).where(eq(chatPlans.id, planId)).get();
          return row ? rowToPlanRow(row) : null;
        }),

      findPlan: (planId) =>
        Effect.sync(() => {
          const row = db.select().from(chatPlans).where(eq(chatPlans.id, planId)).get();
          return row ? rowToPlanRow(row) : null;
        }),

      findPendingPlan: (chatSessionId) =>
        Effect.sync(() => {
          const row = db
            .select()
            .from(chatPlans)
            .where(and(eq(chatPlans.chatSessionId, chatSessionId), eq(chatPlans.status, "pending")))
            .orderBy(desc(chatPlans.sequence))
            .limit(1)
            .get();
          return row ? rowToPlanRow(row) : null;
        }),

      // ── sub-agents ─────────────────────────────────────────────

      startSubagentInvocation: ({
        chatSessionId,
        parentTurnId,
        source,
        providerCallId,
        subagentType,
        description,
        prompt,
      }) =>
        Effect.sync(() => {
          const existing = db
            .select()
            .from(chatSubagentInvocations)
            .where(
              and(
                eq(chatSubagentInvocations.chatSessionId, chatSessionId),
                eq(chatSubagentInvocations.providerCallId, providerCallId),
              ),
            )
            .get();
          if (existing) {
            return { invocationId: existing.id, sequence: existing.sequence };
          }
          const id = crypto.randomUUID();
          const now = nowIso();
          let sequence = 0;
          db.transaction((tx) => {
            const seqRow = tx
              .select({ next: chatSessions.nextSequence })
              .from(chatSessions)
              .where(eq(chatSessions.id, chatSessionId))
              .get();
            if (!seqRow) {
              throw new Error(
                `chat_sessions row ${chatSessionId} disappeared during subagent insert`,
              );
            }
            sequence = seqRow.next;
            tx.update(chatSessions)
              .set({
                nextSequence: sequence + 1,
                lastActivityAt: now,
              })
              .where(eq(chatSessions.id, chatSessionId))
              .run();
            tx.insert(chatSubagentInvocations)
              .values({
                id,
                chatSessionId,
                parentTurnId,
                providerCallId,
                subagentType,
                description,
                prompt,
                status: "running",
                result: null,
                source,
                sequence,
                startedAt: now,
                completedAt: null,
              })
              .run();
          });
          return { invocationId: id, sequence };
        }),

      completeSubagentInvocation: ({ invocationId, result, ok }) =>
        Effect.sync(() => {
          db.update(chatSubagentInvocations)
            .set({
              status: ok ? "completed" : "errored",
              result,
              completedAt: nowIso(),
            })
            .where(eq(chatSubagentInvocations.id, invocationId))
            .run();
        }),

      findSubagentInvocationByProviderId: ({ chatSessionId, providerCallId }) =>
        Effect.sync(() => {
          const row = db
            .select()
            .from(chatSubagentInvocations)
            .where(
              and(
                eq(chatSubagentInvocations.chatSessionId, chatSessionId),
                eq(chatSubagentInvocations.providerCallId, providerCallId),
              ),
            )
            .get();
          return row ? rowToSubagentRow(row) : null;
        }),

      // ── questions ──────────────────────────────────────────────

      createQuestion: ({
        chatSessionId,
        turnId,
        source,
        providerRequestId,
        providerToolCallId,
        previewFormat,
        questions,
      }) =>
        Effect.sync(() => {
          const existing = db
            .select()
            .from(chatQuestions)
            .where(
              and(
                eq(chatQuestions.chatSessionId, chatSessionId),
                eq(chatQuestions.providerRequestId, providerRequestId),
              ),
            )
            .get();
          if (existing) {
            return rowToQuestionRow(existing);
          }
          const id = crypto.randomUUID();
          const now = nowIso();
          let row: ChatQuestionRow | null = null;
          db.transaction((tx) => {
            const seqRow = tx
              .select({ next: chatSessions.nextSequence })
              .from(chatSessions)
              .where(eq(chatSessions.id, chatSessionId))
              .get();
            if (!seqRow) {
              throw new Error(
                `chat_sessions row ${chatSessionId} disappeared during question insert`,
              );
            }
            const sequence = seqRow.next;
            tx.update(chatSessions)
              .set({
                nextSequence: sequence + 1,
                lastActivityAt: now,
              })
              .where(eq(chatSessions.id, chatSessionId))
              .run();
            tx.insert(chatQuestions)
              .values({
                id,
                chatSessionId,
                turnId,
                source,
                providerRequestId,
                providerToolCallId: providerToolCallId ?? null,
                previewFormat,
                questionsJson: JSON.stringify(questions),
                status: "pending",
                answersJson: null,
                customAnswersJson: null,
                sequence,
                createdAt: now,
                answeredAt: null,
              })
              .run();
            row = {
              id,
              chatSessionId,
              turnId,
              source,
              providerRequestId,
              providerToolCallId: providerToolCallId ?? null,
              previewFormat,
              questions,
              status: "pending",
              answers: null,
              customAnswers: null,
              sequence,
              createdAt: now,
              answeredAt: null,
            };
          });
          if (!row) {
            throw new Error("createQuestion transaction did not assign row");
          }
          return row;
        }),

      decideQuestion: ({ questionId, status, answers, customAnswers }) =>
        Effect.sync(() => {
          const existing = db
            .select()
            .from(chatQuestions)
            .where(eq(chatQuestions.id, questionId))
            .get();
          if (!existing) return null;
          if (existing.status !== "pending") {
            // Idempotent: already resolved — return the existing row
            // untouched so concurrent callers (answer endpoint +
            // stream resolution follow-up) settle on the same final state.
            return rowToQuestionRow(existing);
          }
          const now = nowIso();
          db.update(chatQuestions)
            .set({
              status,
              answersJson: answers === undefined ? null : JSON.stringify(answers),
              customAnswersJson: customAnswers === undefined ? null : JSON.stringify(customAnswers),
              answeredAt: now,
            })
            .where(eq(chatQuestions.id, questionId))
            .run();
          const row = db.select().from(chatQuestions).where(eq(chatQuestions.id, questionId)).get();
          return row ? rowToQuestionRow(row) : null;
        }),

      findQuestion: (questionId) =>
        Effect.sync(() => {
          const row = db.select().from(chatQuestions).where(eq(chatQuestions.id, questionId)).get();
          return row ? rowToQuestionRow(row) : null;
        }),

      findPendingQuestion: (chatSessionId) =>
        Effect.sync(() => {
          const row = db
            .select()
            .from(chatQuestions)
            .where(
              and(
                eq(chatQuestions.chatSessionId, chatSessionId),
                eq(chatQuestions.status, "pending"),
              ),
            )
            .orderBy(desc(chatQuestions.sequence))
            .limit(1)
            .get();
          return row ? rowToQuestionRow(row) : null;
        }),

      supersedePendingQuestionsOnBoot: () =>
        Effect.sync(() => {
          // Count first (Bun's drizzle `.run()` returns void, so we
          // can't read `.changes` off the UPDATE). Cheap because the
          // (chat_session_id, status) index covers pending rows.
          const pending = db
            .select({ count: sql<number>`COUNT(*)` })
            .from(chatQuestions)
            .where(eq(chatQuestions.status, "pending"))
            .get();
          const n = pending?.count ?? 0;
          if (n === 0) return 0;
          db.update(chatQuestions)
            .set({ status: "superseded", answeredAt: nowIso() })
            .where(eq(chatQuestions.status, "pending"))
            .run();
          return n;
        }),
    };
  }),
);
