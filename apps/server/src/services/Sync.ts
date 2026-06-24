import type { CommentThread, ThreadMessage, ThreadSummary, UserRole } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { reviewSessions } from "../db/schema/review-sessions";
import { SyncError } from "../domain/errors";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";
import { type GhReviewComment, GitHubGateway } from "./GitHub";
import type { GitHubEtagCache } from "./GitHubEtagCache";
import { PrContextService } from "./PrContext";
import { PullRequestService } from "./PullRequest";
import { RemoteUserService } from "./RemoteUser";
import { RepositoryService } from "./Repository";
import { ReviewService } from "./Review";
import type { SettingsService } from "./Settings";
import { extractGitHubMentions } from "./sync-engine/mentions";
import { latestUpdatedAt } from "./sync-engine/watermark";

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
    ) => Effect.Effect<void, SyncError, DbService | SettingsService>;
    readonly pushReply: (
      messageId: string,
    ) => Effect.Effect<void, SyncError, DbService | SettingsService>;
    readonly pushThreadStatus: (
      threadId: string,
    ) => Effect.Effect<void, SyncError, DbService | SettingsService>;
    readonly pullComments: (
      prId: string,
    ) => Effect.Effect<PullResult, SyncError, DbService | GitHubEtagCache | SettingsService>;
    readonly syncThreads: (
      prId: string,
    ) => Effect.Effect<SyncResult, SyncError, DbService | GitHubEtagCache | SettingsService>;
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
  if (thread.status === "pending_coder") return role !== "coder" && role !== "unknown";
  if (thread.status === "pending_reviewer") return role !== "reviewer" && role !== "unknown";
  return false;
}

export const SyncServiceLive = Layer.effect(
  SyncService,
  Effect.gen(function* () {
    const github = yield* GitHubGateway;
    const prService = yield* PullRequestService;
    const prContext = yield* PrContextService;
    const reviewService = yield* ReviewService;
    const remoteUserService = yield* RemoteUserService;
    const repoService = yield* RepositoryService;
    const broadcaster = yield* Broadcaster;

    // Background-worker PR context — always uses the 'single-user' token.
    const resolvePrContext = (prId: string) => prContext.resolveBasic(prId, "single-user");

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
            new SyncError({ message: `Review session not found: ${sessionId}` }),
          );
        }
        return row.pullRequestId;
      });

    const pushThread = (
      threadId: string,
    ): Effect.Effect<void, SyncError, DbService | SettingsService> =>
      Effect.gen(function* () {
        const thread = yield* reviewService.getThread(threadId);
        if (thread.externalCommentId) return; // already pushed

        const sessionPrId = yield* resolvePrIdFromSession(thread.reviewSessionId);
        const { pr, repo, token } = yield* resolvePrContext(sessionPrId);

        if (!pr.headSha) {
          return yield* Effect.fail(
            new SyncError({ message: "PR headSha missing — cannot push comment", threadId }),
          );
        }

        const messages = yield* reviewService.getMessages(threadId);
        const first = messages[0];
        if (!first) {
          return yield* Effect.fail(
            new SyncError({ message: "Thread has no messages to push", threadId }),
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

        const posted = yield* github.reviews.createComment(
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

        const threadsOnGithub = yield* github.reviews.listThreads(
          repo.fullName,
          pr.externalId,
          token,
        );
        const match = threadsOnGithub.find((t) => t.commentDatabaseIds.includes(posted.id));
        if (match) {
          yield* reviewService.setThreadExternalIds(threadId, {
            externalThreadId: match.nodeId,
          });
        }
      }).pipe(Effect.mapError(toSyncError(threadId)));

    const pushReply = (
      messageId: string,
    ): Effect.Effect<void, SyncError, DbService | SettingsService> =>
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

        const sessionPrId = yield* resolvePrIdFromSession(thread.reviewSessionId);
        const { pr, repo, token } = yield* resolvePrContext(sessionPrId);

        const posted = yield* github.reviews.replyToComment(
          repo.fullName,
          pr.externalId,
          parentCommentId,
          message.body,
          token,
        );
        yield* reviewService.setMessageExternalId(message.id, String(posted.id));
      }).pipe(Effect.mapError(toSyncError()));

    const pushThreadStatus = (
      threadId: string,
    ): Effect.Effect<void, SyncError, DbService | SettingsService> =>
      Effect.gen(function* () {
        const thread = yield* reviewService.getThread(threadId);
        if (!thread.externalThreadId) return;

        const sessionPrId = yield* resolvePrIdFromSession(thread.reviewSessionId);
        const { token } = yield* resolvePrContext(sessionPrId);

        const isResolved = thread.status === "resolved" || thread.status === "wont_fix";
        yield* isResolved
          ? github.reviews.resolveThread(thread.externalThreadId, token)
          : github.reviews.unresolveThread(thread.externalThreadId, token);
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
          if (t.status === "resolved" || t.status === "wont_fix") summary.resolved++;
          else if (rolePendingYou(t, role)) summary.pendingYou++;
          else if (rolePendingThem(t, role)) summary.pendingThem++;
          else summary.open++;
        }
        return summary;
      }).pipe(Effect.mapError(toSyncError()));

    const pullComments = (
      prId: string,
    ): Effect.Effect<PullResult, SyncError, DbService | GitHubEtagCache | SettingsService> =>
      Effect.gen(function* () {
        const { pr, repo, token } = yield* resolvePrContext(prId);
        const accountId = yield* repoService.getAccountIdForRepo(repo.id);
        const session = yield* reviewService.getOrCreateActiveSession(pr.id);

        // Incremental poll: ask GitHub only for comments newer than our
        // last successful sync. Null on cold-start pulls everything.
        const since = yield* prService.getCommentsSyncedAt(pr.id);
        const comments = yield* github.reviews.listComments(
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

        // Local threads the user authored in Revv that aren't yet linked to a
        // GitHub comment id. When the matching comment comes back from the
        // poll we adopt the existing thread rather than creating a duplicate.
        // The post-submit fast-path link (see github-submit.ts) can miss
        // because the `/reviews/:id/comments` response it relies on may return
        // a null `line`; the `/pulls/:n/comments` response used here populates
        // `line` reliably, so this is the authoritative, content-aware dedup.
        const sessionThreads = yield* reviewService.getThreadsForSession(session.id);
        const unsyncedLocal: Array<{
          thread: CommentThread;
          rootMessage: ThreadMessage;
          joinedBody: string;
        }> = [];
        for (const t of sessionThreads) {
          if (t.externalCommentId != null) continue;
          const msgs = yield* reviewService.getMessages(t.id);
          const unsynced = msgs.filter(
            (m) => m.authorRole === "reviewer" && m.externalId == null && m.body.trim().length > 0,
          );
          const root = unsynced[0];
          if (!root) continue;
          unsyncedLocal.push({
            thread: t,
            rootMessage: root,
            // Mirrors the client's buildComments(): a thread's pending reviewer
            // messages are joined into one GitHub comment body.
            joinedBody: unsynced.map((m) => m.body).join("\n\n"),
          });
        }
        const adoptedThreadIds = new Set<string>();

        for (const c of comments) {
          const existingMsg = yield* reviewService.findMessageByExternalId(String(c.id));

          if (existingMsg) {
            if (
              c.updatedAt > (existingMsg.editedAt ?? existingMsg.createdAt) &&
              c.body !== existingMsg.body
            ) {
              yield* reviewService.updateMessageBody(existingMsg.id, c.body, c.updatedAt);
              const updatedMsg = yield* reviewService.getMessage(existingMsg.id);
              yield* broadcaster.broadcastToAccount(accountId, {
                type: "thread:message",
                data: { threadId: existingMsg.threadId, message: updatedMsg },
              });
              edits++;
            }
            continue;
          }

          // Upsert the comment author into remote_users.
          yield* remoteUserService.upsert({
            provider: "github",
            providerUserId: "", // We don't have the numeric ID from GraphQL comments
            login: c.authorLogin,
            avatarUrl: c.authorAvatarUrl,
          });

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
              authorLogin: c.authorLogin,
              body: c.body,
              messageType: "reply",
              externalId: String(c.id),
              createdAt: c.createdAt,
            });
            newMessages++;

            yield* reviewService.transitionStatus(thread.id, authorRole);

            yield* broadcaster.broadcastToAccount(accountId, {
              type: "threads:new-reply",
              data: { prId: pr.id, thread, message: msg },
            });
            continue;
          }

          // Idempotency: the fast-path may have linked the thread
          // (externalCommentId) but not its root message. Don't create a
          // second thread — backfill the message link so future syncs dedup
          // by message id too.
          const linkedThread = yield* reviewService.getThreadByExternalCommentId(
            session.id,
            String(c.id),
          );
          if (linkedThread) {
            const linkedMsgs = yield* reviewService.getMessages(linkedThread.id);
            const unlinked = linkedMsgs.find((m) => m.externalId == null && m.body === c.body);
            if (unlinked) yield* reviewService.setMessageExternalId(unlinked.id, String(c.id));
            continue;
          }

          // Content-based adoption: a local thread the user authored whose
          // post-submit link missed. Match on the reliable location + body.
          const adoptable = unsyncedLocal.find(
            (u) =>
              !adoptedThreadIds.has(u.thread.id) &&
              u.thread.filePath === c.path &&
              u.thread.endLine === (c.line ?? c.startLine ?? 1) &&
              u.thread.diffSide === (c.side === "LEFT" ? "old" : "new") &&
              u.joinedBody === c.body,
          );
          if (adoptable) {
            yield* reviewService.setThreadExternalIds(adoptable.thread.id, {
              externalCommentId: String(c.id),
              lastSyncedAt: new Date().toISOString(),
            });
            yield* reviewService.setMessageExternalId(adoptable.rootMessage.id, String(c.id));
            adoptedThreadIds.add(adoptable.thread.id);
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
            authorLogin: c.authorLogin,
            body: c.body,
            messageType: "comment",
            externalId: String(c.id),
            createdAt: c.createdAt,
          });
          newMessages++;

          yield* reviewService.transitionStatus(thread.id, authorRole);

          yield* broadcaster.broadcastToAccount(accountId, {
            type: "threads:new-reply",
            data: { prId: pr.id, thread, message: msg },
          });
        }

        // Extract @-mentions from newly-synced review comments and append
        // them to the PR's `mentionedUsers` array.
        const commentMentions = comments.flatMap((c) => extractGitHubMentions(c.body));
        if (commentMentions.length > 0) {
          yield* prService
            .appendMentionedUsers(pr.id, commentMentions)
            .pipe(Effect.catchAll(() => Effect.void));
        }

        // Reconcile resolution status via GraphQL — but only when this PR
        // actually has local threads to reconcile. The reconciliation loop
        // matches GitHub threads back to local rows by external comment id;
        // with zero local threads every match is a miss, so the GraphQL call
        // is pure waste. Skipping it removes one GraphQL request per quiet PR
        // on every 30s poll tick — the bulk of PRs most of the time — which is
        // the single biggest contributor to GitHub rate-limit pressure.
        const localThreads = yield* reviewService.getThreadsForSession(session.id);
        const ghThreads =
          localThreads.length === 0
            ? []
            : yield* github.reviews.listThreads(repo.fullName, pr.externalId, token);
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

            const localResolved = local.status === "resolved" || local.status === "wont_fix";
            if (ght.isResolved && !localResolved) {
              yield* reviewService.updateThreadStatus(local.id, "resolved");
              yield* broadcaster.broadcastToAccount(accountId, {
                type: "thread:updated",
                data: { threadId: local.id, status: "resolved" },
              });
              statusChanges++;
            } else if (!ght.isResolved && localResolved) {
              yield* reviewService.updateThreadStatus(local.id, "open");
              yield* broadcaster.broadcastToAccount(accountId, {
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
          const watermark = latestUpdatedAt(comments);
          if (watermark) {
            yield* prService.setCommentsSyncedAt(pr.id, watermark);
          }
        }

        return { newThreads, newMessages, statusChanges, edits };
      }).pipe(Effect.mapError(toSyncError()));

    const syncThreads = (
      prId: string,
    ): Effect.Effect<SyncResult, SyncError, DbService | GitHubEtagCache | SettingsService> =>
      Effect.gen(function* () {
        const pulled = yield* pullComments(prId);
        const summary = yield* getThreadSummary(prId, null);
        const { repo } = yield* resolvePrContext(prId);
        const accountId = yield* repoService.getAccountIdForRepo(repo.id);
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "threads:synced",
          data: { prId, summary, timestamp: new Date().toISOString() },
        });
        return { pulled, summary };
      }).pipe(Effect.mapError(toSyncError()));

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
function findRoot(c: GhReviewComment, byExternalId: Map<number, GhReviewComment>): number {
  let cursor: GhReviewComment | undefined = c;
  for (let i = 0; i < 32 && cursor; i++) {
    if (cursor.inReplyToId === null) return cursor.id;
    const parent = byExternalId.get(cursor.inReplyToId);
    if (!parent) return cursor.inReplyToId;
    cursor = parent;
  }
  return c.id;
}
