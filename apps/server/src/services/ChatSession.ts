// ── ChatSession ────────────────────────────────────────────────────────────
//
// Drizzle wrapper around chat persistence: `chat_sessions` (the durable
// thread handle) plus `chat_messages` and `chat_activities` (the transcript
// + structured tool-use rows added in migration 0110).
//
// Two responsibilities:
//
//   1. Session bookkeeping — find/create per (prId, agent, model, prHeadSha),
//      patch in the ACP session id once the agent reports it.
//   2. Transcript persistence — append user messages, stream assistant
//      content into a single row, append typed activity rows. All inserts
//      atomically allocate `chat_sessions.next_sequence` so messages and
//      activities share one monotonic ordering space.
//
// Session sequence allocation runs inside a SQLite transaction so concurrent
// turns (which shouldn't happen for the same PR but could during retries)
// can't double-issue the same sequence number.

import type { ChatAttachmentMetadata, ChatTask, InteractionMode } from "@revv/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  chatActivities,
  chatMessages,
  chatPlans,
  chatSessions,
  chatTasks,
} from "../db/schema/index";
import type { DbError } from "../domain/errors";
import { dbTry } from "../effects/db-try";
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

export interface ChatMessageRow {
  readonly id: string;
  readonly chatSessionId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly attachments: ReadonlyArray<ChatAttachmentMetadata>;
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
  readonly callId: string | null;
  readonly output: string | null;
  readonly isError: boolean | null;
  readonly sequence: number;
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
  readonly sequence: number;
  readonly createdAt: string;
  readonly decidedAt: string | null;
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
  | (ChatPlanRow & { readonly entryKind: "plan" });

export class ChatSessionService extends Context.Service<
  ChatSessionService,
  {
    readonly find: (
      prId: string,
      agent: string,
      model: string,
      prHeadSha: string,
    ) => Effect.Effect<ChatSessionRow | null, DbError>;
    /** The most recently active session of the PR for (agent, model), at any head. */
    readonly findLatest: (
      prId: string,
      agent: string,
      model: string,
    ) => Effect.Effect<ChatSessionRow | null, DbError>;
    /**
     * The PR heads the PR's sessions were last pinned to, most recently active
     * first: the candidate baselines of the agent branch (`PrWorkspace`).
     */
    readonly baselinesForPr: (prId: string) => Effect.Effect<readonly string[], DbError>;
    /**
     * Look up the existing row for (prId, agent, model, prHeadSha) or insert a
     * fresh one with `session_id = NULL`. Used by the chat route at the
     * START of a turn so subsequent message/activity inserts can FK to
     * the row before the agent emits its session id (which arrives
     * mid-stream).
     */
    readonly findOrCreate: (
      params: FindOrCreateChatSessionParams,
    ) => Effect.Effect<ChatSessionRow, DbError>;
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
    }) => Effect.Effect<void, DbError>;
    /**
     * Update the prHeadSha of an existing session row. Called by the
     * merge-and-push flow after a successful push so the session lookup
     * (keyed on `(prId, agent, model, prHeadSha)`) keeps finding this conversation
     * even after `pull_requests.headSha` advances to the freshly pushed tip.
     */
    readonly updatePrHeadSha: (params: {
      readonly chatSessionId: string;
      readonly prHeadSha: string;
    }) => Effect.Effect<void, DbError>;
    /** Delete every session of the PR, with its transcript. */
    readonly clearForPr: (prId: string) => Effect.Effect<void, DbError>;

    /**
     * Insert a finalized user message. Returns the row's id + the
     * allocated sequence (which the caller may include in outgoing SSE
     * frames once B3 lands).
     */
    readonly appendUserMessage: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly content: string;
      readonly attachments?: ReadonlyArray<ChatAttachmentMetadata>;
    }) => Effect.Effect<{ readonly id: string; readonly sequence: number }, DbError>;

    /**
     * Insert a streaming assistant placeholder. `is_streaming = 1`,
     * empty content. The route appends content via
     * `appendAssistantContent` and finalizes via `finalizeAssistantMessage`.
     */
    readonly beginAssistantMessage: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
    }) => Effect.Effect<{ readonly id: string; readonly sequence: number }, DbError>;

    /** Append `chunk` to the assistant message body in-place. */
    readonly appendAssistantContent: (params: {
      readonly messageId: string;
      readonly chunk: string;
    }) => Effect.Effect<void, DbError>;

    /**
     * Mark the assistant message as no-longer-streaming. If `error` is
     * set, the inline-error chip text persists for renders that follow.
     */
    readonly finalizeAssistantMessage: (params: {
      readonly messageId: string;
      readonly error?: string | null;
    }) => Effect.Effect<void, DbError>;

    readonly appendActivity: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly activityKind: string;
      readonly toolName: string | null;
      readonly summary: string;
      readonly payload?: unknown;
      readonly callId?: string | null;
    }) => Effect.Effect<{ readonly id: string; readonly sequence: number }, DbError>;

    /**
     * Stamp a tool's captured output onto its activity row, matched by provider
     * `callId` *within a turn*. Idempotent last-write-wins; a no-op if the call
     * id is unknown (the activity wasn't persisted, or the result arrived for a
     * different session). Scoping by `turnId` keeps a provider that recycles a
     * `toolCallId` across turns (warm ACP connections span turns) from stamping
     * onto an older turn's row. Powers the clickable output peek after a reload.
     */
    readonly updateActivityResult: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly callId: string;
      readonly output: string;
      readonly isError: boolean;
    }) => Effect.Effect<void, DbError>;

    /**
     * Back-fill an activity's tool input (matched by provider `callId` within a
     * turn) when it arrives after the initial tool-call — so the persisted
     * payload (and thus the filename/command + file peek) survives a reload.
     * Idempotent; a no-op if the call id is unknown. Turn-scoped for the same
     * reason as `updateActivityResult`.
     */
    readonly updateActivityInput: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly callId: string;
      readonly payload: unknown;
    }) => Effect.Effect<void, DbError>;

    /** Read the full timeline for a session, ordered by sequence. */
    readonly listTimeline: (
      chatSessionId: string,
    ) => Effect.Effect<readonly ChatTimelineEntry[], DbError>;

    // ── interaction mode ────────────────────────────────────────────────

    readonly setInteractionMode: (params: {
      readonly chatSessionId: string;
      readonly mode: InteractionMode;
    }) => Effect.Effect<void, DbError>;

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
      readonly tasks: ReadonlyArray<ChatTask>;
    }) => Effect.Effect<readonly ChatTaskRow[], DbError>;

    // ── plans ───────────────────────────────────────────────────────────

    /**
     * Insert a new plan in `pending` status. Throws if a plan already
     * exists for this turn (unique constraint).
     */
    readonly createPlan: (params: {
      readonly chatSessionId: string;
      readonly turnId: string;
      readonly markdown: string;
    }) => Effect.Effect<ChatPlanRow, DbError>;

    /** Decide a plan of one of `prId`'s sessions; null when it has no such plan. */
    readonly decidePlan: (params: {
      readonly prId: string;
      readonly planId: string;
      readonly decision: "approved" | "rejected" | "superseded";
    }) => Effect.Effect<ChatPlanRow | null, DbError>;

    readonly findPendingPlan: (chatSessionId: string) => Effect.Effect<ChatPlanRow | null, DbError>;
  }
>()("ChatSessionService") {}

const nowIso = (): string => new Date().toISOString();

/** Value for the NOT NULL `source` column of `chat_tasks` / `chat_plans`, from when there was more than one driver. */
const LEGACY_SOURCE = "acp";

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

    const parseAttachmentMetadata = (
      value: string | null,
    ): ReadonlyArray<ChatAttachmentMetadata> => {
      if (!value) return [];
      try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) return [];
        const result: ChatAttachmentMetadata[] = [];
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          const kind = record.kind;
          const name = record.name;
          const mimeType = record.mimeType;
          const size = record.size;
          if (
            (kind === "image" || kind === "text") &&
            typeof name === "string" &&
            typeof mimeType === "string" &&
            typeof size === "number"
          ) {
            result.push({ kind, name, mimeType, size });
          }
        }
        return result;
      } catch {
        return [];
      }
    };

    const rowToTaskRow = (row: typeof chatTasks.$inferSelect): ChatTaskRow => ({
      id: row.id,
      chatSessionId: row.chatSessionId,
      turnId: row.turnId,
      taskId: row.taskId,
      content: row.content,
      activeForm: row.activeForm,
      status: row.status as ChatTaskRow["status"],
      priority: (row.priority as ChatTaskRow["priority"]) ?? null,
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
      sequence: row.sequence,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    });

    return {
      find: (prId, agent, model, prHeadSha) =>
        dbTry("chat find", () => {
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

      findLatest: (prId, agent, model) =>
        dbTry("chat findLatest", () => {
          const row = db
            .select()
            .from(chatSessions)
            .where(
              and(
                eq(chatSessions.pullRequestId, prId),
                eq(chatSessions.agent, agent),
                eq(chatSessions.model, model),
              ),
            )
            .orderBy(desc(chatSessions.lastActivityAt))
            .limit(1)
            .get();
          return row ? rowToSessionRow(row) : null;
        }),

      baselinesForPr: (prId) =>
        dbTry("chat baselinesForPr", () =>
          db
            .select({ prHeadSha: chatSessions.prHeadSha })
            .from(chatSessions)
            .where(eq(chatSessions.pullRequestId, prId))
            .orderBy(desc(chatSessions.lastActivityAt))
            .all()
            .map((row) => row.prHeadSha),
        ),

      findOrCreate: ({ prId, agent, model, prHeadSha, worktreePath, branchName }) =>
        dbTry("chat findOrCreate", () => {
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
        dbTry("chat setAgentSessionId", () => {
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
        dbTry("chat updatePrHeadSha", () => {
          db.update(chatSessions)
            .set({ prHeadSha, lastActivityAt: nowIso() })
            .where(eq(chatSessions.id, chatSessionId))
            .run();
        }),

      clearForPr: (prId) =>
        dbTry("chat clearForPr", () => {
          db.delete(chatSessions).where(eq(chatSessions.pullRequestId, prId)).run();
        }),

      appendUserMessage: ({ chatSessionId, turnId, content, attachments }) =>
        dbTry("chat appendUserMessage", () => {
          const sequence = allocateSequence(chatSessionId);
          const id = crypto.randomUUID();
          const now = nowIso();
          const attachmentsJson =
            attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
          db.insert(chatMessages)
            .values({
              id,
              chatSessionId,
              role: "user",
              content,
              attachmentsJson,
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
        dbTry("chat beginAssistantMessage", () => {
          const sequence = allocateSequence(chatSessionId);
          const id = crypto.randomUUID();
          const now = nowIso();
          db.insert(chatMessages)
            .values({
              id,
              chatSessionId,
              role: "assistant",
              content: "",
              attachmentsJson: null,
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
        dbTry("chat appendAssistantContent", () => {
          if (chunk.length === 0) return;
          // SQL `||` concat — atomic and cheap. Avoids a read-modify-
          // write race if two stream callbacks ever interleaved.
          db.run(
            sql`UPDATE chat_messages SET content = content || ${chunk} WHERE id = ${messageId}`,
          );
        }),

      finalizeAssistantMessage: ({ messageId, error }) =>
        dbTry("chat finalizeAssistantMessage", () => {
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
        callId,
      }) =>
        dbTry("chat appendActivity", () => {
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
              callId: callId ?? null,
              output: null,
              isError: null,
              sequence,
              createdAt: now,
            })
            .run();
          return { id, sequence };
        }),

      updateActivityResult: ({ chatSessionId, turnId, callId, output, isError }) =>
        dbTry("chat updateActivityResult", () => {
          db.update(chatActivities)
            .set({ output, isError })
            .where(
              and(
                eq(chatActivities.chatSessionId, chatSessionId),
                eq(chatActivities.turnId, turnId),
                eq(chatActivities.callId, callId),
              ),
            )
            .run();
        }),

      updateActivityInput: ({ chatSessionId, turnId, callId, payload }) =>
        dbTry("chat updateActivityInput", () => {
          db.update(chatActivities)
            .set({ payloadJson: payload === undefined ? null : JSON.stringify(payload) })
            .where(
              and(
                eq(chatActivities.chatSessionId, chatSessionId),
                eq(chatActivities.turnId, turnId),
                eq(chatActivities.callId, callId),
              ),
            )
            .run();
        }),

      listTimeline: (chatSessionId) =>
        dbTry("chat listTimeline", () => {
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
                attachments: parseAttachmentMetadata(m.attachmentsJson),
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
                callId: a.callId,
                output: a.output,
                isError: a.isError,
                sequence: a.sequence,
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
          for (const t of taskEntries) {
            entries.push({ sequence: t.sequence, entry: t });
          }
          entries.sort((a, b) => a.sequence - b.sequence);
          return entries.map((e) => e.entry);
        }),

      // ── interaction mode ───────────────────────────────────────

      setInteractionMode: ({ chatSessionId, mode }) =>
        dbTry("chat setInteractionMode", () => {
          db.update(chatSessions)
            .set({ interactionMode: mode, lastActivityAt: nowIso() })
            .where(eq(chatSessions.id, chatSessionId))
            .run();
        }),

      // ── tasks ──────────────────────────────────────────────────

      applyTaskListSnapshot: ({ chatSessionId, turnId, tasks }) =>
        dbTry("chat applyTaskListSnapshot", () => {
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
                    source: LEGACY_SOURCE,
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
                  sequence,
                  createdAt: now,
                  updatedAt: now,
                });
              }
            }
          });
          return result;
        }),

      // ── plans ──────────────────────────────────────────────────

      createPlan: ({ chatSessionId, turnId, markdown }) =>
        dbTry("chat createPlan", () => {
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
                source: LEGACY_SOURCE,
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

      decidePlan: ({ prId, planId, decision }) =>
        dbTry("chat decidePlan", () => {
          const owned = db
            .select({ id: chatPlans.id })
            .from(chatPlans)
            .innerJoin(chatSessions, eq(chatSessions.id, chatPlans.chatSessionId))
            .where(and(eq(chatPlans.id, planId), eq(chatSessions.pullRequestId, prId)))
            .get();
          if (!owned) return null;
          db.update(chatPlans)
            .set({ status: decision, decidedAt: nowIso() })
            .where(eq(chatPlans.id, planId))
            .run();
          const row = db.select().from(chatPlans).where(eq(chatPlans.id, planId)).get();
          return row ? rowToPlanRow(row) : null;
        }),

      findPendingPlan: (chatSessionId) =>
        dbTry("chat findPendingPlan", () => {
          const row = db
            .select()
            .from(chatPlans)
            .where(and(eq(chatPlans.chatSessionId, chatSessionId), eq(chatPlans.status, "pending")))
            .orderBy(desc(chatPlans.sequence))
            .limit(1)
            .get();
          return row ? rowToPlanRow(row) : null;
        }),
    };
  }),
);
