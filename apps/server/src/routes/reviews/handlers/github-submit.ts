import { draftCommentBody, isPublishableDraftComment } from "@revv/shared";
import { Effect } from "effect";
import { GitHubApiError, GitHubNetworkError, ValidationError } from "../../../domain/errors";
import { logError } from "../../../logger";
import { type CachedDiffFile, DiffCacheService } from "../../../services/DiffCache";
import { GitHubGateway } from "../../../services/github/gateway";
import type { GhCommentAnchor } from "../../../services/github/reviews";
import { diffFileFor, toGitHubComment } from "../../../services/github-review-comment";
import { PollScheduler } from "../../../services/PollScheduler";
import { PrContextService } from "../../../services/PrContext";
import { PrConversationService } from "../../../services/PrConversation";
import { type Conversation, ReviewService } from "../../../services/Review";
import { SyncService } from "../../../services/Sync";
import { WalkthroughService } from "../../../services/Walkthrough";

export interface SubmitReviewInput {
  action: "approve" | "request_changes" | "comment";
  body?: string;
  /**
   * The draft threads the reviewer is posting. Each one still not on GitHub
   * becomes one review comment; any other id is ignored.
   */
  threadIds?: string[];
  /**
   * Walkthrough issue ids included in this submission. Persisted onto the
   * issue rows so the UI's "already posted" state survives reloads and
   * PR-switches. Empty / missing for pure approve flows with no issue list.
   */
  issueIds?: string[];
}

export interface PostedThread {
  threadId: string;
  draftIds: string[];
  comment: GhCommentAnchor;
}

export interface SkippedComment {
  threadId: string;
  path: string;
  line: number;
  reason: string;
}

/**
 * The review comments the chosen threads post: one per thread still not on
 * GitHub, from its drafts. A comment on a file the cached diff no longer holds
 * would make GitHub reject the whole review, so it stays a local draft, as
 * does one whose lines left the diff; with no cached diff nothing is known to
 * be stale.
 */
export function planReviewComments(
  { threads, messages }: Conversation,
  chosen: ReadonlySet<string>,
  cachedFiles: readonly CachedDiffFile[] | null,
): { posted: PostedThread[]; skippedComments: SkippedComment[] } {
  const knowsDiff = cachedFiles !== null && cachedFiles.length > 0;
  const posted: PostedThread[] = [];
  const skippedComments: SkippedComment[] = [];
  for (const thread of threads) {
    if (!chosen.has(thread.id)) continue;
    const drafts = messages[thread.id] ?? [];
    const text = draftCommentBody(thread, drafts);
    if (text === null) continue;
    const skip = (reason: string) =>
      skippedComments.push({
        threadId: thread.id,
        path: thread.filePath,
        line: thread.endLine,
        reason,
      });
    const file = diffFileFor(cachedFiles, thread.filePath);
    if (knowsDiff && !file) {
      skip("the file is no longer part of the diff");
      continue;
    }
    const fit = toGitHubComment(thread, text, file?.patch ?? null);
    if (!fit.ok) {
      skip(fit.reason);
      continue;
    }
    posted.push({
      threadId: thread.id,
      draftIds: drafts.filter(isPublishableDraftComment).map((m) => m.id),
      comment: fit.comment,
    });
  }
  return { posted, skippedComments };
}

/** GitHub refuses a second pending review per user and PR with this 422. */
export function isExistingPendingReviewError(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    error.status === 422 &&
    String(error.cause).toLowerCase().includes("pending review")
  );
}

const logged =
  (what: string) =>
  <E extends { readonly message?: string }>(e: E) =>
    Effect.sync(() => logError("github-submit", `${what}:`, e.message ?? e));

/**
 * POST /api/reviews/:id/github-submit — post the review to GitHub, its line
 * comments built from the chosen draft threads, then bring the local review in
 * line with what GitHub now holds: each posted thread is linked to its GitHub
 * comment (so neither it nor its drafts is ever posted again), the reviewer's
 * pending replies on threads already on GitHub go up, and the PR's threads are
 * pulled back.
 */
export function submitGithubReviewHandler(prId: string, body: SubmitReviewInput) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const github = yield* GitHubGateway;
    const review = yield* ReviewService;
    const sync = yield* SyncService;
    const walkthroughService = yield* WalkthroughService;
    const diffCache = yield* DiffCacheService;
    const conversations = yield* PrConversationService;
    const pollScheduler = yield* PollScheduler;

    const ctx = yield* prContext.forPr(prId);
    const { pr, repo, client, accountId } = ctx;

    const eventMap = {
      approve: "APPROVE",
      request_changes: "REQUEST_CHANGES",
      comment: "COMMENT",
    } as const;

    const cachedFiles = yield* diffCache.getCachedFiles(pr.id);
    const { posted, skippedComments } = planReviewComments(
      yield* review.getConversation(pr.id),
      new Set(body.threadIds ?? []),
      cachedFiles,
    );

    const reviewInput = {
      event: eventMap[body.action],
      body: body.body ?? "",
      comments: posted.map((p) => p.comment),
    };

    // Everything the reviewer picked fell outside the diff, leaving a
    // bodyless COMMENT / REQUEST_CHANGES — which GitHub 422s on its own.
    // Say why here instead of relaying that.
    if (
      body.action !== "approve" &&
      skippedComments.length > 0 &&
      reviewInput.comments.length === 0 &&
      reviewInput.body.trim() === ""
    ) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Nothing to submit: ${skippedComments.length === 1 ? "the comment's line is" : "every comment's line is"} no longer part of the diff.`,
        }),
      );
    }

    const submitted = yield* github.reviews
      .submit(client, repo.fullName, pr.externalId, reviewInput)
      .pipe(
        Effect.catchIf(isExistingPendingReviewError, () =>
          Effect.gen(function* () {
            const reviewer = yield* github.users.viewer(client);
            const pending = yield* github.reviews.findPending(
              client,
              repo.fullName,
              pr.externalId,
              reviewer.login,
            );
            if (!pending) {
              return yield* Effect.fail(
                new GitHubNetworkError({
                  cause:
                    "GitHub reported an existing pending review, but Revv could not find it for the authenticated user.",
                }),
              );
            }

            yield* github.reviews.deletePending(client, repo.fullName, pr.externalId, pending.id);
            return yield* github.reviews.submit(client, repo.fullName, pr.externalId, reviewInput);
          }),
        ),
      );

    // GitHub's review response carries no per-comment ids, so each posted
    // thread is matched back to one of the review's comments.
    if (posted.length > 0) {
      const ghComments = yield* github.reviews
        .commentsForReview(client, repo.fullName, pr.externalId, submitted.id)
        .pipe(
          Effect.catch((e) => logged("list the review's comments")(e).pipe(Effect.as([] as const))),
        );

      for (const { threadId, draftIds, comment } of posted) {
        // Prefer an exact path+line+body match; fall back to path+line, then
        // path+body. The `/reviews/:id/comments` response can return a null
        // `line` and GitHub may normalize the body, so requiring all three
        // exactly would miss. `comment.line` is the fitted line: a clamped
        // anchor comes back on the line that was sent.
        const lineOf = (gh: (typeof ghComments)[number]) => gh.line ?? gh.originalLine;
        const match =
          ghComments.find(
            (gh) =>
              gh.path === comment.path && lineOf(gh) === comment.line && gh.body === comment.body,
          ) ??
          ghComments.find((gh) => gh.path === comment.path && lineOf(gh) === comment.line) ??
          ghComments.find((gh) => gh.path === comment.path && gh.body === comment.body);

        if (match) {
          yield* review
            .linkPostedDrafts(threadId, draftIds, String(match.id), comment.body)
            .pipe(Effect.catch(logged(`link thread ${threadId}`)));
          continue;
        }
        // Unlinked, the draft would be posted again by the next submit. The
        // pull below re-creates it from GitHub with its real id instead.
        yield* review.dropThread(threadId).pipe(Effect.catch(logged(`drop thread ${threadId}`)));
      }
    }

    // The reviewer's replies on threads GitHub already has, one at a time so
    // each thread's replies land in the order they were written.
    const after = yield* review.getConversation(pr.id);
    const pendingReplies = after.threads
      .filter((t) => t.externalCommentId !== null)
      .flatMap((t) =>
        (after.messages[t.id] ?? []).filter(
          (m) => m.externalId === null && m.authorRole === "reviewer",
        ),
      );
    let failedReplies = 0;
    for (const reply of pendingReplies) {
      yield* sync.pushReply(reply.id).pipe(
        Effect.catch((e) =>
          logged(`push reply ${reply.id}`)(e).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                failedReplies++;
              }),
            ),
          ),
        ),
      );
    }

    yield* pollScheduler.syncThreadsNow(pr.id);

    // Stamped regardless of action: an approve whose body includes walkthrough
    // issues also counts as "sent to GitHub".
    const issueIds = body.issueIds ?? [];
    const issuesSubmittedAt =
      issueIds.length > 0 ? yield* walkthroughService.markIssuesSubmitted(issueIds) : null;

    const { conversation } = yield* conversations.afterWrite(ctx, accountId);

    return {
      id: submitted.id,
      htmlUrl: submitted.htmlUrl,
      issuesSubmittedAt,
      submittedIssueIds: issueIds,
      // Comments GitHub could never have accepted. Their local threads are
      // left intact so the reviewer can re-anchor or discard them; the UI
      // names them rather than letting them vanish.
      skippedComments,
      failedReplies,
      conversation,
    };
  });
}
