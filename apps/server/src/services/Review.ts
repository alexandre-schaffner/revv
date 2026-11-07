// A pull request's review: its comment threads and their messages, and every
// change made to them. Each change commits in one transaction and is then
// announced with its envelope (invariant 8), so routes, the GitHub sync and
// the submit flow change threads the same way and announce them the same way.

import type {
  AuthorRole,
  CommentThread,
  MessageType,
  ThreadEventMessage,
  ThreadMessage,
  ThreadStatus,
} from "@revv/shared";
import { canUserModifyComment, isThreadResolved } from "@revv/shared";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Db } from "../db/index";
import { commentThreads } from "../db/schema/comment-threads";
import { avatarOfThreadLogin } from "../db/schema/remote-users";
import { reviewSessions } from "../db/schema/review-sessions";
import { threadMessages } from "../db/schema/thread-messages";
import { type DbError, ForbiddenError, NotFoundError } from "../domain/errors";
import { dbTry } from "../effects/db-try";
import { DbService } from "./Db";
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
    readonly sessionIdFor: (prId: string) => Effect.Effect<string, DbError>;
    /** Every thread on the PR, with its messages. Creates nothing. */
    readonly getConversation: (prId: string) => Effect.Effect<Conversation, DbError>;
    readonly threadsForPr: (prId: string) => Effect.Effect<CommentThread[], DbError>;
    readonly getThread: (threadId: string) => Effect.Effect<ThreadOnPr, NotFoundError | DbError>;
    readonly findThreadByExternalCommentId: (
      prId: string,
      externalCommentId: string,
    ) => Effect.Effect<CommentThread | null, DbError>;
    readonly getMessages: (threadId: string) => Effect.Effect<ThreadMessage[], DbError>;
    readonly getMessage: (
      messageId: string,
    ) => Effect.Effect<ThreadMessage, NotFoundError | DbError>;
    readonly findMessageByExternalId: (
      externalId: string,
    ) => Effect.Effect<ThreadMessage | null, DbError>;

    /** A thread with its first message. Announces `thread:created`. */
    readonly startThread: (
      prId: string,
      anchor: ThreadAnchor & Partial<ThreadGitHubLink>,
      message: NewMessage,
    ) => Effect.Effect<{ thread: CommentThread; message: ThreadMessage }, DbError>;
    /**
     * A message on a thread, which moves the thread's status (see
     * `statusAfterMessage`). Announces `thread:message`, then `thread:updated`
     * when the status moved.
     */
    readonly reply: (
      threadId: string,
      message: NewMessage,
    ) => Effect.Effect<{ thread: CommentThread; message: ThreadMessage }, NotFoundError | DbError>;
    /**
     * A status set in Revv. On a thread that is on GitHub it stays pending
     * until `statusPushed`. Announces `thread:updated`.
     */
    readonly setStatus: (
      threadId: string,
      status: ThreadStatus,
    ) => Effect.Effect<CommentThread, NotFoundError | DbError>;
    /** GitHub took `status`; a status set since stays pending. */
    readonly statusPushed: (threadId: string, status: ThreadStatus) => Effect.Effect<void, DbError>;
    /**
     * Bring a thread's status in line with GitHub's resolved flag, unless a
     * status set in Revv is still waiting to be pushed (`pending`). Announces
     * `thread:updated` when it changed.
     */
    readonly applyRemoteResolved: (
      threadId: string,
      resolved: boolean,
    ) => Effect.Effect<"changed" | "unchanged" | "pending", NotFoundError | DbError>;
    /** A local draft on `threadId` edited in Revv. Announces `thread:message:edited`. */
    readonly editDraft: (
      threadId: string,
      messageId: string,
      body: string,
      actorLogin: string | null,
    ) => Effect.Effect<ThreadMessage, Refusal | DbError>;
    /** A message edited on GitHub. Announces `thread:message:edited`. */
    readonly applyRemoteEdit: (
      messageId: string,
      body: string,
      editedAt: string,
    ) => Effect.Effect<void, NotFoundError | DbError>;
    /** A thread not yet on GitHub, discarded by its author. Announces `thread:deleted`. */
    readonly discardThread: (
      threadId: string,
      actorLogin: string | null,
    ) => Effect.Effect<void, Refusal | DbError>;
    /**
     * A reply on `threadId` not yet on GitHub, discarded by its author. A
     * thread's first message goes with its thread instead. Announces
     * `thread:message:deleted`.
     */
    readonly discardReply: (
      threadId: string,
      messageId: string,
      actorLogin: string | null,
    ) => Effect.Effect<void, Refusal | DbError>;
    /** Drop a thread unconditionally. Announces `thread:deleted`. */
    readonly dropThread: (threadId: string) => Effect.Effect<void, DbError>;

    // GitHub bookkeeping: announces nothing; readers reconcile on their next read.

    readonly linkThread: (
      threadId: string,
      ids: { externalThreadId?: string; externalCommentId?: string; lastSyncedAt?: string },
    ) => Effect.Effect<void, DbError>;
    readonly linkMessage: (messageId: string, externalId: string) => Effect.Effect<void, DbError>;
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
    ) => Effect.Effect<void, DbError>;
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

export function toThread(row: ThreadRow): CommentThread {
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

export function toMessage(row: MessageRow, avatarContent: string | null): ThreadMessage {
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

function readMessages(db: Db | Tx, where: SQL | undefined): ThreadMessage[] {
  return db
    .select({
      msg: threadMessages,
      avatarContent: avatarOfThreadLogin(threadMessages.authorLogin, threadMessages.threadId),
    })
    .from(threadMessages)
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

function insertMessage(
  db: Db | Tx,
  threadId: string,
  params: NewMessage,
  id: string = crypto.randomUUID(),
): ThreadMessage {
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

const threadNotFound = (threadId: string) =>
  new NotFoundError({ resource: "thread", id: threadId });
const messageNotFound = (messageId: string) =>
  new NotFoundError({ resource: "message", id: messageId });

const statusEnvelope = (thread: CommentThread): ThreadEventMessage => ({
  type: "thread:updated",
  data: { threadId: thread.id, status: thread.status, resolvedAt: thread.resolvedAt },
});

/**
 * A thread change made inside the caller's transaction: what it produced, the
 * PR it belongs to, and the envelopes that announce it once the transaction
 * commits (invariant 8). A replay that changes nothing has no envelopes.
 */
export interface ThreadWrite<T> {
  readonly prId: string;
  readonly value: T;
  readonly envelopes: readonly ThreadEventMessage[];
}

/**
 * The thread writes, as plain functions of a transaction. `ReviewService`
 * runs them for routes and the GitHub sync; agent tool handlers, which write
 * in their own synchronous transactions, call them directly. Nothing else
 * writes `comment_threads` / `thread_messages` (deletes cascading from a PR
 * or a walkthrough issue aside).
 */
export const threadWrites = {
  /** A thread with its first message. */
  start(
    tx: Db | Tx,
    prId: string,
    anchor: ThreadAnchor & Partial<ThreadGitHubLink>,
    message: NewMessage,
  ): ThreadWrite<{ thread: CommentThread; message: ThreadMessage }> {
    const row: typeof commentThreads.$inferInsert = {
      id: crypto.randomUUID(),
      reviewSessionId: sessionIdIn(tx, prId),
      filePath: anchor.filePath,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      diffSide: anchor.diffSide,
      status: statusAfterMessage("open", message.authorRole),
      createdAt: new Date().toISOString(),
    };
    if (anchor.externalCommentId !== undefined) row.externalCommentId = anchor.externalCommentId;
    if (anchor.lastSyncedAt !== undefined) row.lastSyncedAt = anchor.lastSyncedAt;
    const thread = toThread(tx.insert(commentThreads).values(row).returning().get());
    const created = { thread, message: insertMessage(tx, thread.id, message) };
    return {
      prId,
      value: created,
      envelopes: [{ type: "thread:created", data: { prId, ...created } }],
    };
  },

  /**
   * Revv's comment on a walkthrough issue, keyed on the caller's
   * deterministic ids: created once, its text replaced on a replay with a new
   * body, untouched on a replay with the same one.
   */
  upsertIssueComment(
    tx: Db | Tx,
    params: {
      readonly prId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly issueId: string;
      readonly anchor: ThreadAnchor;
      readonly body: string;
    },
  ): ThreadWrite<{ thread: CommentThread; message: ThreadMessage }> {
    const { prId, threadId, messageId } = params;
    const now = new Date().toISOString();
    const inserted = tx
      .insert(commentThreads)
      .values({
        id: threadId,
        reviewSessionId: sessionIdIn(tx, prId),
        ...params.anchor,
        status: "open",
        createdAt: now,
        walkthroughIssueId: params.issueId,
      })
      .onConflictDoNothing({ target: commentThreads.id })
      .returning({ id: commentThreads.id })
      .all();
    const before = readMessage(tx, messageId);
    if (!before) {
      insertMessage(
        tx,
        threadId,
        {
          authorRole: "ai_agent",
          authorName: "Revv AI",
          body: params.body,
          messageType: "comment",
          createdAt: now,
        },
        messageId,
      );
    } else if (before.body !== params.body) {
      tx.update(threadMessages)
        .set({ body: params.body, editedAt: now })
        .where(eq(threadMessages.id, messageId))
        .run();
    }
    const threadRow = tx.select().from(commentThreads).where(eq(commentThreads.id, threadId)).get();
    const message = readMessage(tx, messageId);
    if (!threadRow || !message) {
      throw new Error(`issue comment ${threadId} was written but cannot be read back`);
    }
    const thread = toThread(threadRow);
    const envelopes: ThreadEventMessage[] =
      inserted.length > 0
        ? [{ type: "thread:created", data: { prId, thread, message } }]
        : before?.body !== params.body
          ? [{ type: "thread:message:edited", data: { threadId, message } }]
          : [];
    return { prId, value: { thread, message }, envelopes };
  },

  /**
   * A message on a thread, which moves the thread's status (see
   * `statusAfterMessage`). `messageId` makes the caller's own key the row's.
   */
  reply(
    tx: Db | Tx,
    threadId: string,
    message: NewMessage,
    messageId?: string,
  ): ThreadWrite<{ thread: CommentThread; message: ThreadMessage }> | NotFoundError {
    const found = readThreadOnPr(tx, threadId);
    if (!found) return threadNotFound(threadId);
    const inserted = insertMessage(tx, threadId, message, messageId);
    const before = found.row.status as ThreadStatus;
    const status = statusAfterMessage(before, message.authorRole);
    const thread = toThread(
      status === before
        ? found.row
        : tx
            .update(commentThreads)
            .set({ status })
            .where(eq(commentThreads.id, threadId))
            .returning()
            .get(),
    );
    const envelopes: ThreadEventMessage[] = [
      { type: "thread:message", data: { threadId, message: inserted } },
    ];
    if (status !== before) envelopes.push(statusEnvelope(thread));
    return { prId: found.prId, value: { thread, message: inserted }, envelopes };
  },

  /**
   * A status set in Revv. On a thread that is on GitHub it stays pending
   * until GitHub takes it (`statusPushed`), so a pull doesn't revert it.
   * Setting the status a thread already has changes nothing.
   */
  setStatus(
    tx: Db | Tx,
    threadId: string,
    status: ThreadStatus,
  ): ThreadWrite<CommentThread> | NotFoundError {
    const found = readThreadOnPr(tx, threadId);
    if (!found) return threadNotFound(threadId);
    if (found.row.status === status) {
      return { prId: found.prId, value: toThread(found.row), envelopes: [] };
    }
    const thread = toThread(
      tx
        .update(commentThreads)
        .set({
          status,
          resolvedAt: isThreadResolved(status) ? new Date().toISOString() : null,
          statusPushPending: found.row.externalCommentId !== null,
        })
        .where(eq(commentThreads.id, threadId))
        .returning()
        .get(),
    );
    return { prId: found.prId, value: thread, envelopes: [statusEnvelope(thread)] };
  },

  /** A message's new text. `editedAt` defaults to now. */
  editMessage(
    tx: Db | Tx,
    messageId: string,
    body: string,
    editedAt: string = new Date().toISOString(),
  ): ThreadWrite<ThreadMessage> | NotFoundError {
    tx.update(threadMessages).set({ body, editedAt }).where(eq(threadMessages.id, messageId)).run();
    const message = readMessage(tx, messageId);
    if (!message) return messageNotFound(messageId);
    const thread = readThreadOnPr(tx, message.threadId);
    if (!thread) return threadNotFound(message.threadId);
    return {
      prId: thread.prId,
      value: message,
      envelopes: [{ type: "thread:message:edited", data: { threadId: message.threadId, message } }],
    };
  },

  /** A message removed. A thread's first message is the thread: removing it removes the thread. */
  removeMessage(
    tx: Db | Tx,
    threadId: string,
    messageId: string,
  ): ThreadWrite<void> | NotFoundError {
    const found = readThreadOnPr(tx, threadId);
    if (!found) return threadNotFound(threadId);
    if (firstMessageId(tx, threadId) === messageId) return threadWrites.removeThread(tx, threadId);
    tx.delete(threadMessages).where(eq(threadMessages.id, messageId)).run();
    return {
      prId: found.prId,
      value: undefined,
      envelopes: [{ type: "thread:message:deleted", data: { threadId, messageId } }],
    };
  },

  removeThread(tx: Db | Tx, threadId: string): ThreadWrite<void> | NotFoundError {
    const found = readThreadOnPr(tx, threadId);
    if (!found) return threadNotFound(threadId);
    tx.delete(commentThreads).where(eq(commentThreads.id, threadId)).run();
    return {
      prId: found.prId,
      value: undefined,
      envelopes: [{ type: "thread:deleted", data: { threadId } }],
    };
  },
};

export const ReviewServiceLive = Layer.effect(
  ReviewService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const realtime = yield* Realtime;
    /**
     * Run `body` in one transaction. A refusal it returns fails the effect; bodies
     * return one before any write, so nothing needs undoing.
     */
    const transact = <T>(
      label: string,
      body: (tx: Tx) => T,
    ): Effect.Effect<Exclude<T, Refusal>, DbError | Extract<T, Refusal>> =>
      dbTry(label, () => db.transaction((tx) => body(tx))).pipe(
        Effect.flatMap((result) =>
          isRefusal(result)
            ? Effect.fail(result as Extract<T, Refusal>)
            : Effect.succeed(result as Exclude<T, Refusal>),
        ),
      );

    /** Commit `write` in one transaction, then announce what it did. */
    const commit = <T, R extends Refusal = never>(
      label: string,
      write: (tx: Tx) => ThreadWrite<T> | R,
    ): Effect.Effect<T, DbError | R> =>
      dbTry(label, () => db.transaction((tx) => write(tx))).pipe(
        Effect.flatMap((done) => {
          if (isRefusal(done)) return Effect.fail(done as R);
          const { prId, value, envelopes } = done as ThreadWrite<T>;
          return Effect.forEach(envelopes, (msg) => realtime.toPr(prId, msg), {
            discard: true,
          }).pipe(Effect.as(value));
        }),
      );

    /** A draft on `threadId` the actor may still change: not on GitHub, and theirs or Revv's. */
    const modifiableDraft = (
      tx: Tx,
      threadId: string,
      messageId: string,
      actorLogin: string | null,
      verb: "edit" | "discard",
    ): MessageRow | Refusal => {
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
      return row;
    };

    return {
      sessionIdFor: (prId) => dbTry("find the review session", () => sessionIdIn(db, prId)),

      getConversation: (prId) =>
        dbTry("read the conversation", () => {
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
        dbTry("list the PR's threads", () => readThreadsForPr(db, prId).map(toThread)),

      getThread: (threadId) =>
        dbTry("find thread", () => readThreadOnPr(db, threadId)).pipe(
          Effect.flatMap((found) =>
            found
              ? Effect.succeed({ thread: toThread(found.row), prId: found.prId })
              : Effect.fail(threadNotFound(threadId)),
          ),
        ),

      findThreadByExternalCommentId: (prId, externalCommentId) =>
        dbTry("find thread by external comment", () => {
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
        dbTry("list messages", () => readMessages(db, eq(threadMessages.threadId, threadId))),

      getMessage: (messageId) =>
        dbTry("find message", () => readMessage(db, messageId)).pipe(
          Effect.flatMap((message) =>
            message ? Effect.succeed(message) : Effect.fail(messageNotFound(messageId)),
          ),
        ),

      findMessageByExternalId: (externalId) =>
        dbTry(
          "find message by externalId",
          () => readMessages(db, eq(threadMessages.externalId, externalId))[0] ?? null,
        ),

      startThread: (prId, anchor, message) =>
        commit<{ thread: CommentThread; message: ThreadMessage }, never>("start a thread", (tx) =>
          threadWrites.start(tx, prId, anchor, message),
        ),

      reply: (threadId, message) =>
        commit("reply", (tx) => threadWrites.reply(tx, threadId, message)),

      setStatus: (threadId, status) =>
        commit("set thread status", (tx) => threadWrites.setStatus(tx, threadId, status)),

      statusPushed: (threadId, status) =>
        dbTry("mark a thread status pushed", () => {
          db.update(commentThreads)
            .set({ statusPushPending: false })
            .where(and(eq(commentThreads.id, threadId), eq(commentThreads.status, status)))
            .run();
        }),

      applyRemoteResolved: (threadId, resolved) =>
        Effect.gen(function* () {
          const applied = yield* transact("apply GitHub's thread status", (tx) => {
            const found = readThreadOnPr(tx, threadId);
            if (!found) return threadNotFound(threadId);
            const { row } = found;
            const agrees = isThreadResolved(row.status) === resolved;
            if (row.statusPushPending) {
              if (agrees) {
                tx.update(commentThreads)
                  .set({ statusPushPending: false })
                  .where(eq(commentThreads.id, threadId))
                  .run();
              }
              return { outcome: agrees ? ("unchanged" as const) : ("pending" as const) };
            }
            if (agrees) return { outcome: "unchanged" as const };
            const updated = tx
              .update(commentThreads)
              .set({
                status: resolved ? "resolved" : "open",
                resolvedAt: resolved ? new Date().toISOString() : null,
              })
              .where(eq(commentThreads.id, threadId))
              .returning()
              .get();
            return { outcome: "changed" as const, prId: found.prId, thread: toThread(updated) };
          });
          if (applied.outcome === "changed") {
            yield* realtime.toPr(applied.prId, statusEnvelope(applied.thread));
          }
          return applied.outcome;
        }),

      editDraft: (threadId, messageId, body, actorLogin) =>
        commit("edit a draft", (tx) => {
          const draft = modifiableDraft(tx, threadId, messageId, actorLogin, "edit");
          return isRefusal(draft) ? draft : threadWrites.editMessage(tx, messageId, body);
        }),

      applyRemoteEdit: (messageId, body, editedAt) =>
        commit("apply a GitHub edit", (tx) =>
          threadWrites.editMessage(tx, messageId, body, editedAt),
        ).pipe(Effect.asVoid),

      discardThread: (threadId, actorLogin) =>
        commit("discard a thread", (tx) => {
          const firstId = firstMessageId(tx, threadId);
          if (!firstId) return threadNotFound(threadId);
          const draft = modifiableDraft(tx, threadId, firstId, actorLogin, "discard");
          return isRefusal(draft) ? draft : threadWrites.removeThread(tx, threadId);
        }),

      discardReply: (threadId, messageId, actorLogin) =>
        commit("discard a reply", (tx) => {
          const draft = modifiableDraft(tx, threadId, messageId, actorLogin, "discard");
          return isRefusal(draft) ? draft : threadWrites.removeMessage(tx, threadId, messageId);
        }),

      dropThread: (threadId) =>
        commit("drop a thread", (tx) => threadWrites.removeThread(tx, threadId)).pipe(
          Effect.catchTag("NotFoundError", () => Effect.void),
        ),

      linkThread: (threadId, ids) =>
        dbTry("link a thread to GitHub", () => {
          const set: Partial<typeof commentThreads.$inferInsert> = {};
          if (ids.externalThreadId !== undefined) set.externalThreadId = ids.externalThreadId;
          if (ids.externalCommentId !== undefined) set.externalCommentId = ids.externalCommentId;
          if (ids.lastSyncedAt !== undefined) set.lastSyncedAt = ids.lastSyncedAt;
          if (Object.keys(set).length === 0) return;
          db.update(commentThreads).set(set).where(eq(commentThreads.id, threadId)).run();
        }),

      linkMessage: (messageId, externalId) =>
        dbTry("link a message to GitHub", () =>
          db
            .update(threadMessages)
            .set({ externalId })
            .where(eq(threadMessages.id, messageId))
            .run(),
        ).pipe(Effect.asVoid),

      linkPostedDrafts: (threadId, draftIds, externalCommentId, body) =>
        dbTry("link posted drafts", () =>
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
