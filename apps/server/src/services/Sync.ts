import { createHash } from "node:crypto";
import type { CommentThread, ThreadSummary, UserRole } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { reviewSessions } from "../db/schema/review-sessions";
import { SyncError } from "../domain/errors";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";
import { type GhReviewComment, type GhReviewThread, GitHubGateway } from "./GitHub";
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
  /**
   * Whether this pull observed anything new on GitHub — either it wrote rows,
   * or the review-thread fingerprint moved. False means the local mirror
   * already matched GitHub, so there is nothing worth announcing.
   */
  readonly changed: boolean;
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
      userId?: string,
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
    /**
     * Reconcile one PR's threads against GitHub.
     *
     * Pass `force: true` for user-initiated syncs: the `threads:synced`
     * envelope is what clears the client's per-PR spinner, so it must go out
     * even when nothing changed. The background sweep leaves it unset and stays
     * silent on no-op PRs.
     */
    readonly syncThreads: (
      prId: string,
      opts?: { readonly force?: boolean },
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
      userId = "single-user",
    ): Effect.Effect<void, SyncError, DbService | SettingsService> =>
      Effect.gen(function* () {
        const thread = yield* reviewService.getThread(threadId);
        if (thread.externalCommentId) return; // already pushed

        const sessionPrId = yield* resolvePrIdFromSession(thread.reviewSessionId);
        const { pr, repo, token, apiBase } = yield* prContext.resolveBasic(sessionPrId, userId);

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
          apiBase,
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
          apiBase,
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
        const { pr, repo, token, apiBase } = yield* resolvePrContext(sessionPrId);

        const posted = yield* github.reviews.replyToComment(
          repo.fullName,
          pr.externalId,
          parentCommentId,
          message.body,
          token,
          apiBase,
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
        const { token, apiBase } = yield* resolvePrContext(sessionPrId);

        const isResolved = thread.status === "resolved" || thread.status === "wont_fix";
        yield* isResolved
          ? github.reviews.resolveThread(thread.externalThreadId, token, apiBase)
          : github.reviews.unresolveThread(thread.externalThreadId, token, apiBase);
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
        const { pr, repo, token, apiBase } = yield* resolvePrContext(prId);
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
          apiBase,
        );

        let newThreads = 0;
        let newMessages = 0;
        let edits = 0;
        let statusChanges = 0;

        const byExternalId = new Map<number, GhReviewComment>();
        for (const c of comments) byExternalId.set(c.id, c);

        // GitHub's own thread grouping is the authoritative answer to "which
        // thread does this reply belong to", and we need it twice — once to
        // attach incoming replies, once to reconcile resolved/unresolved. Fetch
        // it once, and only when one of those jobs is actually live: a PR with
        // no local threads and no incoming replies has nothing to match, and
        // skipping the GraphQL call there is what keeps quiet PRs free on the
        // background sweep (GraphQL has no conditional-request equivalent, so
        // unlike the REST calls above it is never a free 304).
        const localThreadsBefore = yield* reviewService.getThreadsForSession(session.id);
        const hasIncomingReplies = comments.some((c) => c.inReplyToId !== null);
        const needsGhThreads = localThreadsBefore.length > 0 || hasIncomingReplies;
        const ghThreads = needsGhThreads
          ? yield* github.reviews.listThreads(repo.fullName, pr.externalId, token, apiBase)
          : [];

        // Every comment id GitHub lists in a thread maps to that thread's root
        // (its first comment). This is what `findRootInBatch` can only guess at:
        // that fallback walks `in_reply_to_id` through the current batch, which
        // misses whenever the root falls outside the `since` window — and a miss
        // used to drop the comment permanently, since the watermark then
        // advances past it.
        const rootByCommentId = new Map<number, number>();
        for (const t of ghThreads) {
          const root = t.commentDatabaseIds[0];
          if (root === undefined) continue;
          for (const id of t.commentDatabaseIds) rootByCommentId.set(id, root);
        }

        // Comment authors, deduped by login. One person usually writes several
        // comments in a batch and each upsert costs a SELECT + UPSERT (plus an
        // avatar refetch once the 24h TTL lapses), so collapse them and flush
        // after the ingest loop.
        const pendingAuthors = new Map<string, string | null>();

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

          if (!pendingAuthors.has(c.authorLogin)) {
            pendingAuthors.set(c.authorLogin, c.authorAvatarUrl);
          }

          const authorRole: "reviewer" | "coder" | "ai_agent" =
            c.authorLogin === pr.authorLogin ? "coder" : "reviewer";

          if (c.inReplyToId !== null) {
            const rootId = rootByCommentId.get(c.id) ?? findRootInBatch(c, byExternalId);
            const thread = yield* reviewService.getThreadByExternalCommentId(
              session.id,
              String(rootId),
            );
            if (thread) {
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
            // No local thread owns this reply — its root predates our first
            // sync of this PR, or was pruned by retention. Fall through and
            // ingest it as its own root thread: showing it detached is strictly
            // better than the old behaviour of dropping it and never looking
            // again.
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

        for (const [login, avatarUrl] of pendingAuthors) {
          yield* remoteUserService.upsert({
            provider: "github",
            providerUserId: "", // We don't have the numeric ID from GraphQL comments
            login,
            avatarUrl,
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

        // Did GitHub's side actually move? Row writes are the obvious signal;
        // the thread fingerprint catches the rest (a resolve, an unresolve, a
        // thread appearing or vanishing) without re-deriving it from the DB.
        // When the GraphQL call was skipped there was nothing to fingerprint,
        // so the row writes are the whole answer.
        let changed = newThreads + newMessages + edits + statusChanges > 0;
        if (needsGhThreads) {
          const fingerprint = fingerprintThreads(ghThreads);
          const previous = yield* prService.getThreadsFingerprint(pr.id);
          if (previous !== fingerprint) {
            changed = true;
            yield* prService.setThreadsFingerprint(pr.id, fingerprint);
          }
        }

        return { newThreads, newMessages, statusChanges, edits, changed };
      }).pipe(Effect.mapError(toSyncError()));

    const syncThreads = (
      prId: string,
      opts?: { readonly force?: boolean },
    ): Effect.Effect<SyncResult, SyncError, DbService | GitHubEtagCache | SettingsService> =>
      Effect.gen(function* () {
        const pulled = yield* pullComments(prId);
        const summary = yield* getThreadSummary(prId, null);
        // The background sweep visits every open PR on every tick. Announcing
        // an unchanged summary for each one costs an SSE message per PR and two
        // Map clones in every connected client, for no new information — so stay
        // quiet unless something moved. User-initiated syncs always announce:
        // this envelope is what clears their per-PR spinner.
        if (pulled.changed || opts?.force === true) {
          const { repo } = yield* resolvePrContext(prId);
          const accountId = yield* repoService.getAccountIdForRepo(repo.id);
          yield* broadcaster.broadcastToAccount(accountId, {
            type: "threads:synced",
            data: { prId, summary, timestamp: new Date().toISOString() },
          });
        }
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

/**
 * Fingerprint the externally-observable review-thread state: every thread's
 * node id, resolution flag, and comment ids, order-independent. Two pulls that
 * produce the same fingerprint saw the same GitHub state, so the second has
 * nothing to write and nothing to announce.
 */
function fingerprintThreads(threads: ReadonlyArray<GhReviewThread>): string {
  const canonical = threads
    .map((t) => {
      const ids = [...t.commentDatabaseIds].sort((a, b) => a - b).join(",");
      return `${t.nodeId}:${t.isResolved ? 1 : 0}:${ids}`;
    })
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Best-effort root lookup for a reply, walking `in_reply_to_id` through the
 * comments in the current batch. Only a fallback for when GitHub's own thread
 * grouping is unavailable — it cannot see comments outside the `since` window.
 */
function findRootInBatch(c: GhReviewComment, byExternalId: Map<number, GhReviewComment>): number {
  let cursor: GhReviewComment | undefined = c;
  for (let i = 0; i < 32 && cursor; i++) {
    if (cursor.inReplyToId === null) return cursor.id;
    const parent = byExternalId.get(cursor.inReplyToId);
    if (!parent) return cursor.inReplyToId;
    cursor = parent;
  }
  return c.id;
}
