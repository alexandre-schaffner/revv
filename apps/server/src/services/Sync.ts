import { createHash } from "node:crypto";
import type { ThreadSummary } from "@revv/shared";
import { isThreadResolved, loginsMatch } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import { SyncError } from "../domain/errors";
import { logError } from "../logger";
import { keyedSingleFlight } from "../effects/keyed-single-flight";
import type { DbService } from "./Db";
import { DiffCacheService } from "./DiffCache";
import { GitHubAccounts } from "./github/accounts";
import { AvatarCache } from "./github/avatars";
import type { GitHubClient } from "./github/transport";
import { GitHubGateway } from "./github/gateway";
import type { GhReviewComment, GhReviewThread } from "./github/reviews";
import { diffFileFor, toGitHubComment } from "./github-review-comment";
import { PrContextService } from "./PrContext";
import { PullRequestService } from "./PullRequest";
import { Realtime } from "./Realtime";
import { ReviewService } from "./Review";
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

export class SyncService extends Context.Service<
  SyncService,
  {
    readonly pushThread: (threadId: string) => Effect.Effect<void, SyncError, DbService>;
    readonly pushReply: (messageId: string) => Effect.Effect<void, SyncError, DbService>;
    readonly pushThreadStatus: (threadId: string) => Effect.Effect<void, SyncError, DbService>;
    /** One pull per PR at a time: a call while one is in flight for the same PR joins it. */
    readonly pullComments: (prId: string) => Effect.Effect<PullResult, SyncError, DbService>;
    /**
     * Reconcile one PR's threads against GitHub.
     *
     * Pass `force: true` for user-initiated syncs: the `threads:synced`
     * envelope is what clears the client's per-PR spinner, so it must go out
     * even when nothing changed. The background sweep leaves it unset and stays
     * silent on no-op PRs.
     *
     * Like every background read, it skips an account that needs re-auth or
     * is paused after a rate limit, failing with a `SyncError` that says so.
     */
    readonly syncThreads: (
      prId: string,
      opts?: { readonly force?: boolean },
    ) => Effect.Effect<PullResult, SyncError, DbService>;
    readonly getThreadSummary: (prId: string) => Effect.Effect<ThreadSummary, SyncError, DbService>;
  }
>()("SyncService") {}

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

export const SyncServiceLive = Layer.effect(
  SyncService,
  Effect.gen(function* () {
    const github = yield* GitHubGateway;
    const prService = yield* PullRequestService;
    const prContext = yield* PrContextService;
    const reviewService = yield* ReviewService;
    const avatars = yield* AvatarCache;
    const realtime = yield* Realtime;
    const diffCache = yield* DiffCacheService;
    const accounts = yield* GitHubAccounts;

    const pushThread = (threadId: string): Effect.Effect<void, SyncError, DbService> =>
      Effect.gen(function* () {
        const { thread, prId } = yield* reviewService.getThread(threadId);
        if (thread.externalCommentId) return;

        const { pr, repo, client } = yield* prContext.forPr(prId);

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

        // A file the cached diff doesn't hold is sent as is: the cache trails
        // the PR by a poll cycle, so its absence proves nothing.
        const cachedFiles = yield* diffCache.getCachedFiles(pr.id);
        const fit = toGitHubComment(
          thread,
          first.body,
          diffFileFor(cachedFiles, thread.filePath)?.patch ?? null,
        );
        if (!fit.ok) {
          return yield* Effect.fail(
            new SyncError({
              message: `Cannot post comment on ${thread.filePath}: ${fit.reason}`,
              threadId,
            }),
          );
        }
        const commentPayload = { ...fit.comment, commitSha: pr.headSha };

        const posted = yield* github.reviews.createComment(
          client,
          repo.fullName,
          pr.externalId,
          commentPayload,
        );

        const externalCommentId = String(posted.id);
        yield* reviewService.linkThread(threadId, {
          externalCommentId,
          lastSyncedAt: new Date().toISOString(),
        });
        yield* reviewService.linkMessage(first.id, externalCommentId);

        const threadsOnGithub = yield* github.reviews.listThreads(
          client,
          repo.fullName,
          pr.externalId,
        );
        const match = threadsOnGithub.find((t) => t.commentDatabaseIds.includes(posted.id));
        if (match) {
          yield* reviewService.linkThread(threadId, { externalThreadId: match.nodeId });
        }
      }).pipe(Effect.mapError(toSyncError(threadId)));

    const pushReply = (messageId: string): Effect.Effect<void, SyncError, DbService> =>
      Effect.gen(function* () {
        const message = yield* reviewService.getMessage(messageId);
        if (message.externalId) return;

        const { thread, prId } = yield* reviewService.getThread(message.threadId);
        if (!thread.externalCommentId) {
          yield* pushThread(thread.id);
          const refreshed = yield* reviewService.getMessage(messageId);
          if (refreshed.externalId) return; // this WAS the first message
        }

        const fresh = yield* reviewService.getThread(thread.id);
        const parentCommentId = fresh.thread.externalCommentId;
        if (!parentCommentId) {
          return yield* Effect.fail(
            new SyncError({
              message: "Thread has no external comment id after push",
              threadId: thread.id,
            }),
          );
        }

        const { pr, repo, client } = yield* prContext.forPr(prId);

        const posted = yield* github.reviews.replyToComment(
          client,
          repo.fullName,
          pr.externalId,
          parentCommentId,
          message.body,
        );
        yield* reviewService.linkMessage(message.id, String(posted.id));
      }).pipe(Effect.mapError(toSyncError()));

    const pushStatus = (threadId: string, client?: GitHubClient) =>
      Effect.gen(function* () {
        const { thread, prId } = yield* reviewService.getThread(threadId);
        if (!thread.externalThreadId) return;
        const via = client ?? (yield* prContext.forPr(prId)).client;
        yield* isThreadResolved(thread.status)
          ? github.reviews.resolveThread(via, thread.externalThreadId)
          : github.reviews.unresolveThread(via, thread.externalThreadId);
        yield* reviewService.statusPushed(threadId, thread.status);
      }).pipe(Effect.mapError(toSyncError(threadId)));

    const pushThreadStatus = (threadId: string): Effect.Effect<void, SyncError, DbService> =>
      pushStatus(threadId);

    const getThreadSummary = (prId: string): Effect.Effect<ThreadSummary, SyncError, DbService> =>
      Effect.gen(function* () {
        const threads = yield* reviewService.threadsForPr(prId);

        const resolved = threads.filter((t) => isThreadResolved(t.status)).length;
        return { total: threads.length, open: threads.length - resolved, resolved };
      }).pipe(Effect.mapError(toSyncError()));

    const pullCommentsFromGitHub = (
      prId: string,
    ): Effect.Effect<PullResult, SyncError, DbService> =>
      Effect.gen(function* () {
        const { pr, repo, accountId } = yield* prContext.forPr(prId);
        const client = yield* accounts.backgroundClient(accountId, "core");
        if (client === null) {
          return yield* Effect.fail(
            new SyncError({
              message: "GitHub sync is paused for this account (sign-in needed or rate limited)",
            }),
          );
        }

        // Incremental poll: ask GitHub only for comments newer than our
        // last successful sync. Null on cold-start pulls everything.
        const since = yield* prService.getCommentsSyncedAt(pr.id);
        const comments = yield* github.reviews.listComments(
          client,
          repo.fullName,
          pr.externalId,
          since,
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
        const localThreadsBefore = yield* reviewService.threadsForPr(pr.id);
        const hasIncomingReplies = comments.some((c) => c.inReplyToId !== null);
        const needsGhThreads = localThreadsBefore.length > 0 || hasIncomingReplies;
        const ghThreads = needsGhThreads
          ? yield* github.reviews.listThreads(client, repo.fullName, pr.externalId)
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
              yield* reviewService.applyRemoteEdit(existingMsg.id, c.body, c.updatedAt);
              edits++;
            }
            continue;
          }

          if (!pendingAuthors.has(c.authorLogin)) {
            pendingAuthors.set(c.authorLogin, c.authorAvatarUrl);
          }

          const authorRole: "reviewer" | "coder" | "ai_agent" = loginsMatch(
            c.authorLogin,
            pr.authorLogin,
          )
            ? "coder"
            : "reviewer";

          if (c.inReplyToId !== null) {
            const rootId = rootByCommentId.get(c.id) ?? findRootInBatch(c, byExternalId);
            const thread = yield* reviewService.findThreadByExternalCommentId(
              pr.id,
              String(rootId),
            );
            if (thread) {
              yield* reviewService.reply(thread.id, {
                authorRole,
                authorName: c.authorLogin,
                authorLogin: c.authorLogin,
                body: c.body,
                messageType: "reply",
                externalId: String(c.id),
                createdAt: c.createdAt,
              });
              newMessages++;
              continue;
            }
            // No local thread owns this reply — its root predates our first
            // sync of this PR, or was pruned by retention. Fall through and
            // ingest it as its own root thread: showing it detached is strictly
            // better than the old behaviour of dropping it and never looking
            // again.
          }

          yield* reviewService.startThread(
            pr.id,
            {
              filePath: c.path,
              startLine: c.startLine ?? c.line ?? 1,
              endLine: c.line ?? c.startLine ?? 1,
              diffSide: c.side === "LEFT" ? "old" : "new",
              externalCommentId: String(c.id),
              lastSyncedAt: new Date().toISOString(),
            },
            {
              authorRole,
              authorName: c.authorLogin,
              authorLogin: c.authorLogin,
              body: c.body,
              messageType: "comment",
              externalId: String(c.id),
              createdAt: c.createdAt,
            },
          );
          newThreads++;
          newMessages++;
        }

        for (const [login, avatarUrl] of pendingAuthors) {
          yield* avatars.ensure(repo.githubHost, login, avatarUrl);
        }

        // Extract @-mentions from newly-synced review comments and append
        // them to the PR's `mentionedUsers` array.
        const commentMentions = comments.flatMap((c) => extractGitHubMentions(c.body));
        if (commentMentions.length > 0) {
          yield* prService
            .appendMentionedUsers(pr.id, commentMentions)
            .pipe(Effect.catch(() => Effect.void));
        }

        for (const ght of ghThreads) {
          for (const cdbId of ght.commentDatabaseIds) {
            const local = yield* reviewService.findThreadByExternalCommentId(pr.id, String(cdbId));
            if (!local) continue;

            if (!local.externalThreadId) {
              yield* reviewService.linkThread(local.id, { externalThreadId: ght.nodeId });
            }

            const applied = yield* reviewService.applyRemoteResolved(local.id, ght.isResolved);
            if (applied === "changed") statusChanges++;
            if (applied === "pending") {
              yield* pushStatus(local.id, client).pipe(
                Effect.catch((e) =>
                  Effect.sync(() =>
                    logError("sync", `push status of ${local.id} to GitHub:`, e.message),
                  ),
                ),
              );
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

    const pullOnce = keyedSingleFlight<string, PullResult, SyncError>();
    const pullComments = (prId: string): Effect.Effect<PullResult, SyncError, DbService> =>
      pullOnce(prId, pullCommentsFromGitHub(prId));

    const syncThreads = (
      prId: string,
      opts?: { readonly force?: boolean },
    ): Effect.Effect<PullResult, SyncError, DbService> =>
      Effect.gen(function* () {
        const pulled = yield* pullComments(prId);
        // The background sweep visits every open PR on every tick; announcing
        // a no-op for each would be an SSE message per PR for nothing. A
        // user-initiated sync always announces: it clears their spinner.
        if (pulled.changed || opts?.force === true) {
          yield* realtime.toPr(prId, {
            type: "threads:synced",
            data: { prId, timestamp: new Date().toISOString() },
          });
        }
        return pulled;
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
