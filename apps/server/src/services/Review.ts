// A pull request's review: its comment threads and their messages, and every
// change made to them. Each change commits in one transaction and is then
// announced with its envelope (invariant 8), so routes, the GitHub sync and
// the submit flow change threads the same way and announce them the same way.

import type {
  AuthorRole,
  CommentThread,
  MessageType,
  ServerEventMessage,
  ThreadMessage,
  ThreadStatus,
} from "@revv/shared";
import { canUserModifyComment, isThreadResolved } from "@revv/shared";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Db } from "../db/index";
import { commentThreads } from "../db/schema/comment-threads";
import { remoteUsers } from "../db/schema/remote-users";
import { reviewSessions } from "../db/schema/review-sessions";
import { threadMessages } from "../db/schema/thread-messages";
import { type DbError, ForbiddenError, NotFoundError } from "../domain/errors";
import { tryDb } from "../effects/db-try";
import type { DbService } from "./Db";
import { Realtime } from "./Realtime";

export interface ThreadAnchor {
  filePath: string;
  startLine: number;
  endLine: number;
  diffSide: "old" | "new";
}

/** Set when the thread mirrors a comment that is already on GitHub. */
export interface ThreadGitHubLink {
  externalCommentId: string;
  lastSyncedAt: string;
}

export interface NewMessage {
  authorRole: AuthorRole;
  authorName: string;
  authorLogin?: string;
  body: string;
  messageType: MessageType;
  codeSuggestion?: string;
  externalId?: string;
  createdAt?: string;
}

export interface ThreadOnPr {
  thread: CommentThread;
  prId: string;
}

export interface Conversation {
  threads: CommentThread[];
  messages: Record<string, ThreadMessage[]>;
}

type Refusal = NotFoundError | ForbiddenError;

export class ReviewService extends Context.Service<
  ReviewService,
  {
    /** The PR's review session, created the first time something hangs off it. */
    readonly sessionIdFor: (prId: string) => Effect.Effect<string, DbError, DbService>;
    /** Every thread on the PR, with its messages. Creates nothing. */
    readonly getConversation: (prId: string) => Effect.Effect<Conversation, DbError, DbService>;
    readonly threadsForPr: (prId: string) => Effect.Effect<CommentThread[], DbError, DbService>;
    readonly getThread: (
      threadId: string,
    ) => Effect.Effect<ThreadOnPr, NotFoundError | DbError, DbService>;
    readonly findThreadByExternalCommentId: (
      prId: string,
      externalCommentId: string,
    ) => Effect.Effect<CommentThread | null, DbError, DbService>;
    readonly getMessages: (threadId: string) => Effect.Effect<ThreadMessage[], DbError, DbService>;
    readonly getMessage: (
      messageId: string,
    ) => Effect.Effect<ThreadMessage, NotFoundError | DbError, DbService>;
    readonly findMessageByExternalId: (
      externalId: string,
    ) => Effect.Effect<ThreadMessage | null, DbError, DbService>;

    // ── Changes, announced after they commit ────────────────────────────────

    /** A thread with its first message. Announces `thread:created`. */
    readonly startThread: (
      prId: string,
      anchor: ThreadAnchor & Partial<ThreadGitHubLink>,
      message: NewMessage,
    ) => Effect.Effect<{ thread: CommentThread; message: ThreadMessage }, DbError, DbService>;
    /**
     * A message on a thread, which moves the thread's status (see
     * `statusAfterMessage`). Announces `thread:message`, then `thread:updated`
     * when the status moved.
     */
    readonly reply: (
      threadId: string,
      message: NewMessage,
    ) => Effect.Effect<
      { thread: CommentThread; message: ThreadMessage },
      NotFoundError | DbError,
      DbService
    >;
    /** Announces `thread:updated`. */
    readonly setStatus: (
      threadId: string,
      status: ThreadStatus,
    ) => Effect.Effect<CommentThread, NotFoundError | DbError, DbService>;
    /** A local draft on `threadId` edited in Revv. Announces `thread:message:edited`. */
    readonly editDraft: (
      threadId: string,
      messageId: string,
      body: string,
      actorLogin: string | null,
    ) => Effect.Effect<ThreadMessage, Refusal | DbError, DbService>;
    /** A message edited on GitHub. Announces `thread:message:edited`. */
    readonly applyRemoteEdit: (
      messageId: string,
      body: string,
      editedAt: string,
    ) => Effect.Effect<void, NotFoundError | DbError, DbService>;
    /** A thread not yet on GitHub, discarded by its author. Announces `thread:deleted`. */
    readonly discardThread: (
      threadId: string,
      actorLogin: string | null,
    ) => Effect.Effect<void, Refusal | DbError, DbService>;
    /**
     * A reply on `threadId` not yet on GitHub, discarded by its author. A
     * thread's first message goes with its thread instead. Announces
     * `thread:message:deleted`.
     */
    readonly discardReply: (
      threadId: string,
      messageId: string,
      actorLogin: string | null,
    ) => Effect.Effect<void, Refusal | DbError, DbService>;
    /** Drop a thread unconditionally. Announces `thread:deleted`. */
    readonly dropThread: (threadId: string) => Effect.Effect<void, DbError, DbService>;

    // ── GitHub bookkeeping: no envelope, readers reconcile on their next read ─

    readonly linkThread: (
      threadId: string,
      ids: { externalThreadId?: string; externalCommentId?: string; lastSyncedAt?: string },
    ) => Effect.Effect<void, DbError, DbService>;
    readonly linkMessage: (
      messageId: string,
      externalId: string,
    ) => Effect.Effect<void, DbError, DbService>;
    /**
     * A thread's drafts went up to GitHub as the one comment `externalCommentId`
     * whose text is `body`. The first draft becomes that comment and the
     * others, now part of it, go, so none of them is posted again as a reply.
     */
    readonly linkPostedDrafts: (
      threadId: string,
      draftIds: readonly string[],
      externalCommentId: string,
      body: string,
    ) => Effect.Effect<void, DbError, DbService>;
  }
>()("ReviewService") {}

/**
 * The status a message leaves its thread in. A reviewer hands the thread to
 * the author and the author hands it back. Revv's own messages and closed
 * threads stay put: a reply never reopens a thread.
 */
export function statusAfterMessage(status: ThreadStatus, authorRole: AuthorRole): ThreadStatus {
  if (authorRole === "ai_agent" || isThreadResolved(status)) return status;
  return authorRole === "reviewer" ? "pending_coder" : "pending_reviewer";
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ThreadRow = typeof commentThreads.$inferSelect;
type MessageRow = typeof threadMessages.$inferSelect;

function toThread(row: ThreadRow): CommentThread {
  return {
    id: row.id,
    reviewSessionId: row.reviewSessionId,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    diffSide: row.diffSide as CommentThread["diffSide"],
    status: row.status as ThreadStatus,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
    externalThreadId: row.externalThreadId ?? null,
    externalCommentId: row.externalCommentId ?? null,
    lastSyncedAt: row.lastSyncedAt ?? null,
  };
}

function toMessage(row: MessageRow, avatarContent: string | null): ThreadMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    authorRole: row.authorRole as AuthorRole,
    authorName: row.authorName,
    authorLogin: row.authorLogin ?? null,
    authorAvatarContent: avatarContent,
    body: row.body,
    messageType: row.messageType as MessageType,
    codeSuggestion: row.codeSuggestion ?? null,
    createdAt: row.createdAt,
    editedAt: row.editedAt ?? null,
    externalId: row.externalId ?? null,
  };
}

/** Messages with their author's cached avatar, oldest first. */
function readMessages(db: Db | Tx, where: SQL | undefined): ThreadMessage[] {
  return db
    .select({ msg: threadMessages, avatarContent: remoteUsers.avatarContent })
    .from(threadMessages)
    .leftJoin(
      remoteUsers,
      and(eq(remoteUsers.provider, "github"), eq(remoteUsers.login, threadMessages.authorLogin)),
    )
    .where(where)
    .orderBy(asc(threadMessages.createdAt))
    .all()
    .map((r) => toMessage(r.msg, r.avatarContent));
}

function readMessage(db: Db | Tx, messageId: string): ThreadMessage | undefined {
  return readMessages(db, eq(threadMessages.id, messageId))[0];
}

function readThreadOnPr(db: Db | Tx, threadId: string): { row: ThreadRow; prId: string } | null {
  const found = db
    .select({ row: commentThreads, prId: reviewSessions.pullRequestId })
    .from(commentThreads)
    .innerJoin(reviewSessions, eq(reviewSessions.id, commentThreads.reviewSessionId))
    .where(eq(commentThreads.id, threadId))
    .get();
  return found ?? null;
}

function readThreadsForPr(db: Db | Tx, prId: string): ThreadRow[] {
  return db
    .select({ row: commentThreads })
    .from(commentThreads)
    .innerJoin(reviewSessions, eq(reviewSessions.id, commentThreads.reviewSessionId))
    .where(eq(reviewSessions.pullRequestId, prId))
    .orderBy(asc(commentThreads.createdAt))
    .all()
    .map((r) => r.row);
}

function sessionIdIn(db: Db | Tx, prId: string): string {
  db.insert(reviewSessions)
    .values({ id: crypto.randomUUID(), pullRequestId: prId, startedAt: new Date().toISOString() })
    .onConflictDoNothing({ target: reviewSessions.pullRequestId })
    .run();
  const row = db
    .select({ id: reviewSessions.id })
    .from(reviewSessions)
    .where(eq(reviewSessions.pullRequestId, prId))
    .get();
  if (!row) throw new Error(`no review session for ${prId} after creating it`);
  return row.id;
}

function firstMessageId(db: Db | Tx, threadId: string): string | undefined {
  return db
    .select({ id: threadMessages.id })
    .from(threadMessages)
    .where(eq(threadMessages.threadId, threadId))
    .orderBy(asc(threadMessages.createdAt))
    .limit(1)
    .get()?.id;
}

function insertMessage(db: Db | Tx, threadId: string, params: NewMessage): ThreadMessage {
  const id = crypto.randomUUID();
  const row: typeof threadMessages.$inferInsert = {
    id,
    threadId,
    authorRole: params.authorRole,
    authorName: params.authorName,
    body: params.body,
    messageType: params.messageType,
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
  if (params.authorLogin !== undefined) row.authorLogin = params.authorLogin;
  if (params.codeSuggestion !== undefined) row.codeSuggestion = params.codeSuggestion;
  if (params.externalId !== undefined) row.externalId = params.externalId;
  db.insert(threadMessages).values(row).run();
  const message = readMessage(db, id);
  if (!message) throw new Error(`message ${id} missing after insert`);
  return message;
}

const isRefusal = (value: unknown): value is Refusal =>
  value instanceof NotFoundError || value instanceof ForbiddenError;

/**
 * Run `body` in one transaction. A refusal it returns fails the effect; bodies
 * return one before any write, so nothing needs undoing.
 */
const transact = <T>(
  label: string,
  body: (tx: Tx) => T,
): Effect.Effect<Exclude<T, Refusal>, DbError | Extract<T, Refusal>, DbService> =>
  tryDb(label, (db) => db.transaction((tx) => body(tx))).pipe(
    Effect.flatMap((result) =>
      isRefusal(result)
        ? Effect.fail(result as Extract<T, Refusal>)
        : Effect.succeed(result as Exclude<T, Refusal>),
    ),
  );

const threadNotFound = (threadId: string) =>
  new NotFoundError({ resource: "thread", id: threadId });
const messageNotFound = (messageId: string) =>
  new NotFoundError({ resource: "message", id: messageId });

export const ReviewServiceLive = Layer.effect(
  ReviewService,
  Effect.gen(function* () {
    const realtime = yield* Realtime;
    const announce = (prId: string, ...messages: ServerEventMessage[]) =>
      Effect.forEach(messages, (msg) => realtime.toPr(prId, msg), { discard: true });

    /** A draft on `threadId` the actor may still change: not on GitHub, and theirs or Revv's. */
    const modifiableDraft = (
      tx: Tx,
      threadId: string,
      messageId: string,
      actorLogin: string | null,
      verb: "edit" | "discard",
    ): { row: MessageRow; prId: string } | Refusal => {
      const row = tx.select().from(threadMessages).where(eq(threadMessages.id, messageId)).get();
      if (!row || row.threadId !== threadId) return messageNotFound(messageId);
      if (row.externalId !== null) {
        return new ForbiddenError({
          message:
            verb === "edit"
              ? "Cannot edit a message that has already been synced to GitHub"
              : "Cannot discard a reply already synced to GitHub",
        });
      }
      if (!canUserModifyComment(row, actorLogin)) {
        return new ForbiddenError({
          message: `You can only ${verb} your own comments or comments left by Revv`,
        });
      }
      const thread = readThreadOnPr(tx, row.threadId);
      if (!thread) return threadNotFound(row.threadId);
      return { row, prId: thread.prId };
    };

    return {
      sessionIdFor: (prId) => tryDb("find the review session", (db) => sessionIdIn(db, prId)),

      getConversation: (prId) =>
        tryDb("read the conversation", (db) => {
          const threads = readThreadsForPr(db, prId).map(toThread);
          const messages: Record<string, ThreadMessage[]> = {};
          for (const thread of threads) messages[thread.id] = [];
          if (threads.length > 0) {
            const all = readMessages(
              db,
              inArray(
                threadMessages.threadId,
                threads.map((t) => t.id),
              ),
            );
            for (const message of all) messages[message.threadId]?.push(message);
          }
          return { threads, messages };
        }),

      threadsForPr: (prId) =>
        tryDb("list the PR's threads", (db) => readThreadsForPr(db, prId).map(toThread)),

      getThread: (threadId) =>
        tryDb("find thread", (db) => readThreadOnPr(db, threadId)).pipe(
          Effect.flatMap((found) =>
            found
              ? Effect.succeed({ thread: toThread(found.row), prId: found.prId })
              : Effect.fail(threadNotFound(threadId)),
          ),
        ),

      findThreadByExternalCommentId: (prId, externalCommentId) =>
        tryDb("find thread by external comment", (db) => {
          const found = db
            .select({ row: commentThreads })
            .from(commentThreads)
            .innerJoin(reviewSessions, eq(reviewSessions.id, commentThreads.reviewSessionId))
            .where(
              and(
                eq(reviewSessions.pullRequestId, prId),
                eq(commentThreads.externalCommentId, externalCommentId),
              ),
            )
            .get();
          return found ? toThread(found.row) : null;
        }),

      getMessages: (threadId) =>
        tryDb("list messages", (db) => readMessages(db, eq(threadMessages.threadId, threadId))),

      getMessage: (messageId) =>
        tryDb("find message", (db) => readMessage(db, messageId)).pipe(
          Effect.flatMap((message) =>
            message ? Effect.succeed(message) : Effect.fail(messageNotFound(messageId)),
          ),
        ),

      findMessageByExternalId: (externalId) =>
        tryDb(
          "find message by externalId",
          (db) => readMessages(db, eq(threadMessages.externalId, externalId))[0] ?? null,
        ),

      startThread: (prId, anchor, params) =>
        Effect.gen(function* () {
          const created = yield* transact("start a thread", (tx) => {
            const row: typeof commentThreads.$inferInsert = {
              id: crypto.randomUUID(),
              reviewSessionId: sessionIdIn(tx, prId),
              filePath: anchor.filePath,
              startLine: anchor.startLine,
              endLine: anchor.endLine,
              diffSide: anchor.diffSide,
              status: statusAfterMessage("open", params.authorRole),
              createdAt: new Date().toISOString(),
            };
            if (anchor.externalCommentId !== undefined) {
              row.externalCommentId = anchor.externalCommentId;
            }
            if (anchor.lastSyncedAt !== undefined) row.lastSyncedAt = anchor.lastSyncedAt;
            const thread = tx.insert(commentThreads).values(row).returning().get();
            return { thread: toThread(thread), message: insertMessage(tx, thread.id, params) };
          });
          yield* announce(prId, { type: "thread:created", data: { prId, ...created } });
          return created;
        }),

      reply: (threadId, params) =>
        Effect.gen(function* () {
          const { prId, before, thread, message } = yield* transact("reply", (tx) => {
            const found = readThreadOnPr(tx, threadId);
            if (!found) return threadNotFound(threadId);
            const message = insertMessage(tx, threadId, params);
            const before = found.row.status as ThreadStatus;
            const status = statusAfterMessage(before, params.authorRole);
            const thread =
              status === before
                ? found.row
                : tx
                    .update(commentThreads)
                    .set({ status })
                    .where(eq(commentThreads.id, threadId))
                    .returning()
                    .get();
            return { prId: found.prId, before, thread: toThread(thread), message };
          });
          yield* announce(prId, { type: "thread:message", data: { threadId, message } });
          if (thread.status !== before) {
            yield* announce(prId, {
              type: "thread:updated",
              data: { threadId, status: thread.status, resolvedAt: thread.resolvedAt },
            });
          }
          return { thread, message };
        }),

      setStatus: (threadId, status) =>
        Effect.gen(function* () {
          const { prId, thread } = yield* transact("set thread status", (tx) => {
            const found = readThreadOnPr(tx, threadId);
            if (!found) return threadNotFound(threadId);
            const resolvedAt = isThreadResolved(status) ? new Date().toISOString() : null;
            const row = tx
              .update(commentThreads)
              .set({ status, resolvedAt })
              .where(eq(commentThreads.id, threadId))
              .returning()
              .get();
            return { prId: found.prId, thread: toThread(row) };
          });
          yield* announce(prId, {
            type: "thread:updated",
            data: { threadId, status: thread.status, resolvedAt: thread.resolvedAt },
          });
          return thread;
        }),

      editDraft: (threadId, messageId, body, actorLogin) =>
        Effect.gen(function* () {
          const { prId, message } = yield* transact("edit a draft", (tx) => {
            const draft = modifiableDraft(tx, threadId, messageId, actorLogin, "edit");
            if (isRefusal(draft)) return draft;
            tx.update(threadMessages)
              .set({ body, editedAt: new Date().toISOString() })
              .where(eq(threadMessages.id, messageId))
              .run();
            const message = readMessage(tx, messageId);
            if (!message) return messageNotFound(messageId);
            return { prId: draft.prId, message };
          });
          yield* announce(prId, { type: "thread:message:edited", data: { threadId, message } });
          return message;
        }),

      applyRemoteEdit: (messageId, body, editedAt) =>
        Effect.gen(function* () {
          const { prId, message } = yield* transact("apply a GitHub edit", (tx) => {
            tx.update(threadMessages)
              .set({ body, editedAt })
              .where(eq(threadMessages.id, messageId))
              .run();
            const message = readMessage(tx, messageId);
            if (!message) return messageNotFound(messageId);
            const thread = readThreadOnPr(tx, message.threadId);
            if (!thread) return threadNotFound(message.threadId);
            return { prId: thread.prId, message };
          });
          yield* announce(prId, {
            type: "thread:message:edited",
            data: { threadId: message.threadId, message },
          });
        }),

      discardThread: (threadId, actorLogin) =>
        Effect.gen(function* () {
          const prId = yield* transact("discard a thread", (tx) => {
            const found = readThreadOnPr(tx, threadId);
            if (!found) return threadNotFound(threadId);
            if (found.row.externalCommentId !== null) {
              return new ForbiddenError({
                message: "Cannot discard a thread already synced to GitHub",
              });
            }
            const firstId = firstMessageId(tx, threadId);
            const first = firstId
              ? tx.select().from(threadMessages).where(eq(threadMessages.id, firstId)).get()
              : undefined;
            if (!first) return new NotFoundError({ resource: "thread message", id: threadId });
            if (!canUserModifyComment(first, actorLogin)) {
              return new ForbiddenError({
                message: "You can only discard your own comments or comments left by Revv",
              });
            }
            tx.delete(commentThreads).where(eq(commentThreads.id, threadId)).run();
            return found.prId;
          });
          yield* announce(prId, { type: "thread:deleted", data: { threadId } });
        }),

      discardReply: (threadId, messageId, actorLogin) =>
        Effect.gen(function* () {
          const prId = yield* transact("discard a reply", (tx) => {
            const draft = modifiableDraft(tx, threadId, messageId, actorLogin, "discard");
            if (isRefusal(draft)) return draft;
            if (firstMessageId(tx, threadId) === messageId) {
              return new ForbiddenError({
                message: "Cannot discard a thread's first message — discard the thread instead",
              });
            }
            tx.delete(threadMessages).where(eq(threadMessages.id, messageId)).run();
            return draft.prId;
          });
          yield* announce(prId, {
            type: "thread:message:deleted",
            data: { threadId, messageId },
          });
        }),

      dropThread: (threadId) =>
        Effect.gen(function* () {
          const found = yield* tryDb("drop a thread", (db) => {
            const thread = readThreadOnPr(db, threadId);
            db.delete(commentThreads).where(eq(commentThreads.id, threadId)).run();
            return thread;
          });
          if (found) yield* announce(found.prId, { type: "thread:deleted", data: { threadId } });
        }),

      linkThread: (threadId, ids) =>
        tryDb("link a thread to GitHub", (db) => {
          const set: Partial<typeof commentThreads.$inferInsert> = {};
          if (ids.externalThreadId !== undefined) set.externalThreadId = ids.externalThreadId;
          if (ids.externalCommentId !== undefined) set.externalCommentId = ids.externalCommentId;
          if (ids.lastSyncedAt !== undefined) set.lastSyncedAt = ids.lastSyncedAt;
          if (Object.keys(set).length === 0) return;
          db.update(commentThreads).set(set).where(eq(commentThreads.id, threadId)).run();
        }),

      linkMessage: (messageId, externalId) =>
        tryDb("link a message to GitHub", (db) =>
          db
            .update(threadMessages)
            .set({ externalId })
            .where(eq(threadMessages.id, messageId))
            .run(),
        ).pipe(Effect.asVoid),

      linkPostedDrafts: (threadId, draftIds, externalCommentId, body) =>
        tryDb("link posted drafts", (db) =>
          db.transaction((tx) => {
            const [first, ...rest] = draftIds;
            tx.update(commentThreads)
              .set({ externalCommentId, lastSyncedAt: new Date().toISOString() })
              .where(eq(commentThreads.id, threadId))
              .run();
            if (first === undefined) return;
            tx.update(threadMessages)
              .set({ externalId: externalCommentId, body })
              .where(eq(threadMessages.id, first))
              .run();
            if (rest.length > 0) {
              tx.delete(threadMessages).where(inArray(threadMessages.id, rest)).run();
            }
          }),
        ),
    };
  }),
);
