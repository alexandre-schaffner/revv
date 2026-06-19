import { Effect } from "effect";
import { GitHubNetworkError } from "../../../domain/errors";
import { AppRuntime } from "../../../runtime";
import { Broadcaster } from "../../../services/Broadcaster";
import { GitHubGateway } from "../../../services/GitHub";
import { PrContextService } from "../../../services/PrContext";
import { RepositoryService } from "../../../services/Repository";
import { ReviewService } from "../../../services/Review";
import { WalkthroughService } from "../../../services/Walkthrough";

export interface SubmitReviewCommentInput {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  threadId: string;
}

export interface SubmitReviewInput {
  action: "approve" | "request_changes" | "comment";
  body?: string;
  comments?: SubmitReviewCommentInput[];
  /**
   * Walkthrough issue ids included in this submission. Persisted onto the
   * issue rows so the UI's "already posted" state survives reloads and
   * PR-switches. Empty / missing for pure approve flows with no issue list.
   */
  issueIds?: string[];
}

interface SubmittedCommentLink {
  readonly threadId: string;
  readonly externalCommentId: string;
}

function isExistingPendingReviewError(error: unknown): boolean {
  return (
    error instanceof GitHubNetworkError &&
    typeof error.cause === "string" &&
    error.cause.includes("User can only have one pending review per pull request")
  );
}

/**
 * POST /api/reviews/:id/github-submit — submit a review to GitHub with
 * line-level comments. Maps our internal action type to GitHub's `event`
 * enum and builds the multi-line comment payloads the REST API expects.
 *
 * After posting, we fetch the created review comments from GitHub and link
 * them back to the corresponding local threads/messages via their external IDs.
 * This prevents pullComments (called by sync-threads immediately after) from
 * treating our own comments as new and creating duplicate threads.
 */
export function submitGithubReviewHandler(prId: string, userId: string, body: SubmitReviewInput) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const prContext = yield* PrContextService;
      const github = yield* GitHubGateway;
      const reviewService = yield* ReviewService;
      const walkthroughService = yield* WalkthroughService;
      const repoService = yield* RepositoryService;
      const broadcaster = yield* Broadcaster;

      const { pr, repo, token: ghToken } = yield* prContext.resolveBasic(prId, userId);
      const accountId = yield* repoService.getAccountIdForRepo(repo.id);

      const eventMap = {
        approve: "APPROVE",
        request_changes: "REQUEST_CHANGES",
        comment: "COMMENT",
      } as const;

      const inputComments = body.comments ?? [];
      const comments = inputComments.map((c) => {
        const comment: {
          path: string;
          body: string;
          line: number;
          side: "LEFT" | "RIGHT";
          startLine?: number;
          startSide?: "LEFT" | "RIGHT";
        } = {
          path: c.path,
          body: c.body,
          line: c.line,
          side: c.side,
        };
        if (c.startLine !== undefined && c.startLine !== c.line) {
          comment.startLine = c.startLine;
          comment.startSide = c.side;
        }
        return comment;
      });

      const submittedCommentLinks: SubmittedCommentLink[] = [];
      const reviewInput = {
        event: eventMap[body.action],
        body: body.body ?? "",
        comments,
      };
      const review = yield* github.reviews
        .submit(repo.fullName, pr.externalId, reviewInput, ghToken)
        .pipe(
          Effect.catchIf(isExistingPendingReviewError, () =>
            Effect.gen(function* () {
              const reviewer = yield* github.users.authenticatedFresh(ghToken);
              const pending = yield* github.reviews.findPending(
                repo.fullName,
                pr.externalId,
                reviewer.login,
                ghToken,
              );
              if (!pending) {
                return yield* Effect.fail(
                  new GitHubNetworkError({
                    cause:
                      "GitHub reported an existing pending review, but Revv could not find it for the authenticated user.",
                  }),
                );
              }

              const submitted = yield* github.reviews.submitPending(
                repo.fullName,
                pr.externalId,
                pending.id,
                {
                  event: reviewInput.event,
                  body: reviewInput.body,
                },
                ghToken,
              );

              const commitSha = pr.headSha;
              if (!commitSha) {
                return yield* Effect.fail(
                  new GitHubNetworkError({
                    cause:
                      "Cannot post review comments because the pull request head SHA is missing locally. Sync the PR and retry.",
                  }),
                );
              }

              for (const [index, comment] of comments.entries()) {
                const input = inputComments[index];
                if (!input) continue;
                const posted = yield* github.reviews.createComment(
                  repo.fullName,
                  pr.externalId,
                  {
                    ...comment,
                    commitSha,
                  },
                  ghToken,
                );
                submittedCommentLinks.push({
                  threadId: input.threadId,
                  externalCommentId: String(posted.id),
                });
              }

              return submitted;
            }),
          ),
        );

      // Link local threads to GitHub comment IDs so that the subsequent
      // sync-threads call doesn't create duplicate entries.
      for (const link of submittedCommentLinks) {
        yield* reviewService
          .setThreadExternalIds(link.threadId, {
            externalCommentId: link.externalCommentId,
          })
          .pipe(Effect.orElseSucceed(() => undefined));

        const messages = yield* reviewService
          .getMessages(link.threadId)
          .pipe(Effect.orElseSucceed(() => []));
        const unsyncedMsg = [...messages]
          .reverse()
          .find((m) => m.authorRole === "reviewer" && m.externalId == null);
        if (unsyncedMsg) {
          yield* reviewService
            .setMessageExternalId(unsyncedMsg.id, link.externalCommentId)
            .pipe(Effect.orElseSucceed(() => undefined));
        }
      }

      if (inputComments.length > 0) {
        const linkedThreadIds = new Set(submittedCommentLinks.map((link) => link.threadId));
        const ghComments = yield* github.reviews
          .commentsForReview(repo.fullName, pr.externalId, review.id, ghToken)
          .pipe(Effect.orElseSucceed(() => []));

        for (const input of inputComments) {
          if (linkedThreadIds.has(input.threadId)) continue;
          const effectiveLine = input.line;
          // Prefer an exact path+line+body match; fall back to path+line, then
          // path+body. The `/reviews/:id/comments` response can return a null
          // `line` and GitHub may normalize the body, so requiring all three
          // exactly would miss — leaving the comment unlinked and re-postable.
          const match =
            ghComments.find((gh) => {
              const ghLine = gh.line ?? gh.originalLine;
              return gh.path === input.path && ghLine === effectiveLine && gh.body === input.body;
            }) ??
            ghComments.find((gh) => {
              const ghLine = gh.line ?? gh.originalLine;
              return gh.path === input.path && ghLine === effectiveLine;
            }) ??
            ghComments.find((gh) => gh.path === input.path && gh.body === input.body);

          if (!match) {
            // We couldn't tie this just-pushed comment to its GitHub id (the
            // review API returns no per-comment ids, and GitHub can normalize
            // the body, defeating a body match). Rather than leave an unlinked
            // local draft that a later submit would re-post, delete it — the
            // sync-threads call that follows re-creates it from GitHub with a
            // real externalCommentId. Local-only metadata (a freshly authored
            // comment has none worth keeping) is sacrificed to guarantee no
            // duplicate ever reaches GitHub.
            yield* reviewService
              .deleteThread(input.threadId)
              .pipe(Effect.orElseSucceed(() => undefined));
            yield* broadcaster
              .broadcastToAccount(accountId, {
                type: "thread:deleted",
                data: { threadId: input.threadId },
              })
              .pipe(Effect.orElseSucceed(() => undefined));
            continue;
          }

          // Set external ID on the thread row
          yield* reviewService
            .setThreadExternalIds(input.threadId, {
              externalCommentId: String(match.id),
            })
            .pipe(Effect.orElseSucceed(() => undefined));

          // Find the last unsynced reviewer message in this thread and link it
          const messages = yield* reviewService
            .getMessages(input.threadId)
            .pipe(Effect.orElseSucceed(() => []));
          const unsyncedMsg = [...messages]
            .reverse()
            .find((m) => m.authorRole === "reviewer" && m.externalId == null);
          if (unsyncedMsg) {
            yield* reviewService
              .setMessageExternalId(unsyncedMsg.id, String(match.id))
              .pipe(Effect.orElseSucceed(() => undefined));
          }
        }
      }

      // Persist which walkthrough issues the reviewer just sent so the
      // "already posted" treatment (grayed-out, unselectable) survives
      // reloads and PR-switches. Stamped regardless of action — an
      // approve that happens to include walkthrough issues in the body
      // also counts as "sent to GitHub."
      const issueIds = body.issueIds ?? [];
      const issuesSubmittedAt =
        issueIds.length > 0 ? yield* walkthroughService.markIssuesSubmitted(issueIds) : null;

      return {
        id: review.id,
        htmlUrl: review.htmlUrl,
        issuesSubmittedAt,
        submittedIssueIds: issueIds,
      };
    }),
  );
}
