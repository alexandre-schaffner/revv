import type { CommentThread, ThreadSummary, UserRole } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { reviewSessions } from "../db/schema/review-sessions";
import { SyncError } from "../domain/errors";
import { DbService } from "./Db";
import { type GhReviewComment, GitHubService } from "./GitHub";
import { PrContextService } from "./PrContext";
import { PullRequestService } from "./PullRequest";
import { ReviewService } from "./Review";
import { WebSocketHub } from "./WebSocketHub";

export interface PullResult {
  readonly newThreads: number;
  readonly newMessages: number;
  readonly statusChanges: number;
  readonly edits: number;
}

export interface SyncResult {
  readonly pulled: PullResult;
  readonly summary: ThreadSummary;
}

export class SyncService extends Context.Tag("SyncService")<
  SyncService,
  {
    readonly pushThread: (
      threadId: string,
    ) => Effect.Effect<void, SyncError, DbService>;
    readonly pushReply: (
      messageId: string,
    ) => Effect.Effect<void, SyncError, DbService>;
    readonly pushThreadStatus: (
      threadId: string,
    ) => Effect.Effect<void, SyncError, DbService>;
    readonly pullComments: (
      prId: string,
    ) => Effect.Effect<PullResult, SyncError, DbService>;
    readonly syncThreads: (
      prId: string,
    ) => Effect.Effect<SyncResult, SyncError, DbService>;
    readonly getThreadSummary: (
      prId: string,
      userLogin: string | null,
    ) => Effect.Effect<ThreadSummary, SyncError, DbService>;
  }
>() {}

/** Wrap any non-SyncError into a SyncError. Used as a uniform error funnel. */
function toSyncError(threadId?: string): (e: unknown) => SyncError {
  return (e: unknown) => {
    if (e instanceof SyncError) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new SyncError({
      message,
      cause: e,
      ...(threadId !== undefined ? { threadId } : {}),
    });
  };
}

/** Role-aware "is this my turn" check — used for summary + UI gutter colors. */
function rolePendingYou(thread: CommentThread, role: UserRole): boolean {
  if (thread.status === "pending_coder") return role === "coder";
  if (thread.status === "pending_reviewer") return role === "reviewer";
  return false;
}

function rolePendingThem(thread: CommentThread, role: UserRole): boolean {
  if (thread.status === "pending_coder")
    return role !== "coder" && role !== "unknown";
  if (thread.status === "pending_reviewer")
    return role !== "reviewer" && role !== "unknown";
  return false;
}

export const SyncServiceLive = Layer.effect(
  SyncService,
  Effect.gen(function* () {
    const github = yield* GitHubService;
    const prService = yield* PullRequestService;
    const prContext = yield* PrContextService;
    const reviewService = yield* ReviewService;
    const hub = yield* WebSocketHub;

    // Background-worker PR context — always uses the 'single-user' token.
    const resolvePrContext = (prId: string) =>
      prContext.resolveBasic(prId, "single-user");

    const resolvePrIdFromSession = (
      sessionId: string,
    ): Effect.Effect<string, SyncError, DbService> =>
      Effect.gen(function* () {
        const { db } = yield* DbService;
        const row = db
          .select({ pullRequestId: reviewSessions.pullRequestId })
          .from(reviewSessions)
          .where(eq(reviewSessions.id, sessionId))
          .get();
        if (!row) {
          return yield* Effect.fail(
            new SyncError({
              message: `Review session not found: ${sessionId}`,
            }),
          );
        }
        return row.pullRequestId;
      });

    const pushThread = (
      threadId: string,
    ): Effect.Effect<void, SyncError, DbService> =>
      Effect.gen(function* () {
        const thread = yield* reviewService.getThread(threadId);
        if (thread.externalCommentId) return; // already pushed

        const sessionPrId = yield* resolvePrIdFromSession(
          thread.reviewSessionId,
        );
        const { pr, repo, token } = yield* resolvePrContext(sessionPrId);

        if (!pr.headSha) {
          return yield* Effect.fail(
            new SyncError({
              message: "PR headSha missing — cannot push comment",
              threadId,
            }),
          );
        }

        const messages = yield* reviewService.getMessages(threadId);
        const first = messages[0];
        if (!first) {
          return yield* Effect.fail(
            new SyncError({
              message: "Thread has no messages to push",
              threadId,
            }),
          );
        }

        const commentPayload: {
          path: string;
          body: string;
          line: number;
          side: "LEFT" | "RIGHT";
          commitSha: string;
          startLine?: number;
          startSide?: "LEFT" | "RIGHT";
        } = {
          path: thread.filePath,
          body: first.body,
          line: thread.endLine,
          side: thread.diffSide === "old" ? "LEFT" : "RIGHT",
          commitSha: pr.headSha,
        };
        if (thread.startLine !== thread.endLine) {
          commentPayload.startLine = thread.startLine;
          commentPayload.startSide = commentPayload.side;
        }

        const posted = yield* github.postReviewComment(
          repo.fullName,
          pr.externalId,
          commentPayload,
          token,
        );

        const externalCommentId = String(posted.id);
        yield* reviewService.setThreadExternalIds(threadId, {
          externalCommentId,
          lastSyncedAt: new Date().toISOString(),
        });
        yield* reviewService.setMessageExternalId(first.id, externalCommentId);

        const threadsOnGithub = yield* github.listReviewThreads(
          repo.fullName,
          pr.externalId,
          token,
        );
        const match = threadsOnGithub.find((t) =>
          t.commentDatabaseIds.includes(posted.id),
        );
        if (match) {
          yield* reviewService.setThreadExternalIds(threadId, {
            externalThreadId: match.nodeId,
          });
        }
      }).pipe(Effect.mapError(toSyncError(threadId)));

    const pushReply = (
      messageId: string,
    ): Effect.Effect<void, SyncError, DbService> =>
      Effect.gen(function* () {
        const message = yield* reviewService.getMessage(messageId);
        if (message.externalId) return;

        const thread = yield* reviewService.getThread(message.threadId);
        if (!thread.externalCommentId) {
          yield* pushThread(thread.id);
          const refreshed = yield* reviewService.getMessage(messageId);
          if (refreshed.externalId) return; // this WAS the first message
        }

        const freshThread = yield* reviewService.getThread(thread.id);
        const parentCommentId = freshThread.externalCommentId;
        if (!parentCommentId) {
          return yield* Effect.fail(
            new SyncError({
              message: "Thread has no external comment id after push",
              threadId: thread.id,
            }),
          );
        }

        const sessionPrId = yield* resolvePrIdFromSession(
          thread.reviewSessionId,
        );
        const { pr, repo, token } = yield* resolvePrContext(sessionPrId);

        const posted = yield* github.replyToComment(
          repo.fullName,
          pr.externalId,
          parentCommentId,
          message.body,
          token,
        );
        yield* reviewService.setMessageExternalId(
          message.id,
          String(posted.id),
        );
      }).pipe(Effect.mapError(toSyncError()));

    const pushThreadStatus = (
      threadId: string,
    ): Effect.Effect<void, SyncError, DbService> =>
      Effect.gen(function* () {
        const thread = yield* reviewService.getThread(threadId);
        if (!thread.externalThreadId) return;

        const sessionPrId = yield* resolvePrIdFromSession(
          thread.reviewSessionId,
        );
        const { token } = yield* resolvePrContext(sessionPrId);

        const isResolved =
          thread.status === "resolved" || thread.status === "wont_fix";
        yield* isResolved
          ? github.resolveReviewThread(thread.externalThreadId, token)
          : github.unresolveReviewThread(thread.externalThreadId, token);
      }).pipe(Effect.mapError(toSyncError(threadId)));

    const getThreadSummary = (
      prId: string,
      userLogin: string | null,
    ): Effect.Effect<ThreadSummary, SyncError, DbService> =>
      Effect.gen(function* () {
        const session = yield* reviewService.getOrCreateActiveSession(prId);
        const threads = yield* reviewService.getThreadsForSession(session.id);

        let role: UserRole = "unknown";
        if (userLogin) {
          const pr = yield* prService.getPr(prId);
          role = pr.authorLogin === userLogin ? "coder" : "reviewer";
        }

        const summary: ThreadSummary = {
          total: threads.length,
          open: 0,
          pendingYou: 0,
          pendingThem: 0,
          resolved: 0,
        };
        for (const t of threads) {
          if (t.status === "resolved" || t.status === "wont_fix")
            summary.resolved++;
          else if (rolePendingYou(t, role)) summary.pendingYou++;
          else if (rolePendingThem(t, role)) summary.pendingThem++;
          else summary.open++;
        }
        return summary;
      }).pipe(Effect.mapError(toSyncError()));

    const pullComments = (
      prId: string,
    ): Effect.Effect<PullResult, SyncError, DbService> =>
      Effect.gen(function* () {
        const { pr, repo, token } = yield* resolvePrContext(prId);
        const session = yield* reviewService.getOrCreateActiveSession(pr.id);

        // Incremental poll: ask GitHub only for comments newer than our
        // last successful sync. Null on cold-start pulls everything.
        const since = yield* prService.getCommentsSyncedAt(pr.id);
        const comments = yield* github.listReviewComments(
          repo.fullName,
          pr.externalId,
          since,
          token,
        );

        let newThreads = 0;
        let newMessages = 0;
        let edits = 0;
        let statusChanges = 0;

        const byExternalId = new Map<number, GhReviewComment>();
        for (const c of comments) byExternalId.set(c.id, c);

        for (const c of comments) {
          const existingMsg = yield* reviewService.findMessageByExternalId(
            String(c.id),
          );

          if (existingMsg) {
            // Backfill avatar URL for rows synced before this field existed,
            // or if GitHub rotated the user's avatar. Avatar URLs are
            // idempotent and cheap to overwrite — do it unconditionally
            // when the stored value drifts from the remote one.
            if (existingMsg.authorAvatarUrl !== c.authorAvatarUrl) {
              yield* reviewService.setMessageAvatar(
                existingMsg.id,
                c.authorAvatarUrl,
              );
            }
            if (
              c.updatedAt > (existingMsg.editedAt ?? existingMsg.createdAt) &&
              c.body !== existingMsg.body
            ) {
              yield* reviewService.updateMessageBody(
                existingMsg.id,
                c.body,
                c.updatedAt,
              );
              const updatedMsg = yield* reviewService.getMessage(
                existingMsg.id,
              );
              yield* hub.broadcast({
                type: "thread:message",
                data: { threadId: existingMsg.threadId, message: updatedMsg },
              });
              edits++;
            }
            continue;
          }

          const authorRole: "reviewer" | "coder" | "ai_agent" =
            c.authorLogin === pr.authorLogin ? "coder" : "reviewer";

          if (c.inReplyToId !== null) {
            const root = findRoot(c, byExternalId);
            const thread = yield* reviewService.getThreadByExternalCommentId(
              session.id,
              String(root),
            );
            if (!thread) continue;

            const msg = yield* reviewService.addMessage(thread.id, {
              authorRole,
              authorName: c.authorLogin,
              authorAvatarUrl: c.authorAvatarUrl,
              body: c.body,
              messageType: "reply",
              externalId: String(c.id),
              createdAt: c.createdAt,
            });
            newMessages++;

            yield* reviewService.transitionStatus(thread.id, authorRole);

            yield* hub.broadcast({
              type: "threads:new-reply",
              data: { prId: pr.id, thread, message: msg },
            });
            continue;
          }

          const thread = yield* reviewService.createThread(session.id, {
            filePath: c.path,
            startLine: c.startLine ?? c.line ?? 1,
            endLine: c.line ?? c.startLine ?? 1,
            diffSide: c.side === "LEFT" ? "old" : "new",
            externalCommentId: String(c.id),
            lastSyncedAt: new Date().toISOString(),
          });
          newThreads++;

          const msg = yield* reviewService.addMessage(thread.id, {
            authorRole,
            authorName: c.authorLogin,
            authorAvatarUrl: c.authorAvatarUrl,
            body: c.body,
            messageType: "comment",
            externalId: String(c.id),
            createdAt: c.createdAt,
          });
          newMessages++;

          yield* reviewService.transitionStatus(thread.id, authorRole);

          yield* hub.broadcast({
            type: "threads:new-reply",
            data: { prId: pr.id, thread, message: msg },
          });
        }

        // Reconcile resolution status via GraphQL.
        const ghThreads = yield* github.listReviewThreads(
          repo.fullName,
          pr.externalId,
          token,
        );
        for (const ght of ghThreads) {
          for (const cdbId of ght.commentDatabaseIds) {
            const local = yield* reviewService.getThreadByExternalCommentId(
              session.id,
              String(cdbId),
            );
            if (!local) continue;

            if (!local.externalThreadId) {
              yield* reviewService.setThreadExternalIds(local.id, {
                externalThreadId: ght.nodeId,
              });
            }

            const localResolved =
              local.status === "resolved" || local.status === "wont_fix";
            if (ght.isResolved && !localResolved) {
              yield* reviewService.updateThreadStatus(local.id, "resolved");
              yield* hub.broadcast({
                type: "thread:updated",
                data: { threadId: local.id, status: "resolved" },
              });
              statusChanges++;
            } else if (!ght.isResolved && localResolved) {
              yield* reviewService.updateThreadStatus(local.id, "open");
              yield* hub.broadcast({
                type: "thread:updated",
                data: { threadId: local.id, status: "open" },
              });
              statusChanges++;
            }
            break;
          }
        }

        // Advance the high-water-mark only when the GitHub call
        // succeeded AND produced comments — otherwise keep the old
        // watermark so the next tick refetches from the same point.
        if (comments.length > 0) {
          const watermark = comments.reduce(
            (max, c) => (c.updatedAt > max ? c.updatedAt : max),
            "",
          );
          if (watermark) {
            yield* prService.setCommentsSyncedAt(pr.id, watermark);
          }
        }

        return { newThreads, newMessages, statusChanges, edits };
      }).pipe(Effect.mapError(toSyncError()));

    const syncThreads = (
      prId: string,
    ): Effect.Effect<SyncResult, SyncError, DbService> =>
      Effect.gen(function* () {
        const pulled = yield* pullComments(prId);
        const summary = yield* getThreadSummary(prId, null);
        yield* hub.broadcast({
          type: "threads:synced",
          data: { prId, summary, timestamp: new Date().toISOString() },
        });
        return { pulled, summary };
      });

    return {
      pushThread,
      pushReply,
      pushThreadStatus,
      pullComments,
      syncThreads,
      getThreadSummary,
    };
  }),
);

/** Walk up the reply chain to find the root comment's database id. */
function findRoot(
  c: GhReviewComment,
  byExternalId: Map<number, GhReviewComment>,
): number {
  let cursor: GhReviewComment | undefined = c;
  for (let i = 0; i < 32 && cursor; i++) {
    if (cursor.inReplyToId === null) return cursor.id;
    const parent = byExternalId.get(cursor.inReplyToId);
    if (!parent) return cursor.inReplyToId;
    cursor = parent;
  }
  return c.id;
}
