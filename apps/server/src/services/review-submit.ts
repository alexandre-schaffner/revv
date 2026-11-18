import {
  ISSUE_SEVERITY_TAG,
  issueLocation,
  messagesInReview,
  type ReviewAction,
  unpublishedReplies,
  type WalkthroughIssue,
} from "@revv/shared";
import { Effect } from "effect";
import { GitHubApiError, GitHubNetworkError, ValidationError } from "../domain/errors";
import { logError } from "../logger";
import { type CachedDiffFile, DiffCacheService } from "./DiffCache";
import { GitHubAccounts } from "./github/accounts";
import { GitHubGateway } from "./github/gateway";
import type { GhCommentAnchor } from "./github/reviews";
import { planThreadComment } from "./github-review-comment";
import { PrContextService } from "./PrContext";
import { PrConversationService } from "./PrConversation";
import { type Conversation, ReviewService } from "./Review";
import { SyncService } from "./Sync";
import { WalkthroughService } from "./walkthrough/Walkthrough";

export interface SubmitReviewInput {
  action: ReviewAction;
  /**
   * The threads the reviewer is posting on. One still not on GitHub becomes a
   * review comment; one GitHub has gets the reviewer's pending replies. A
   * thread left out keeps its drafts local. Revv's own comment on a
   * walkthrough issue rides along only when that issue is in `issueIds`.
   */
  threadIds?: string[];
  /**
   * The walkthrough issues the review lists, in order. They make up its body,
   * and are stamped as submitted so "already posted" survives reloads.
   */
  issueIds?: string[];
}

/** The review body: the chosen walkthrough issues as a markdown list, or empty. */
export function reviewBody(issues: readonly WalkthroughIssue[]): string {
  if (issues.length === 0) return "";
  const lines = issues.map((issue) => {
    const location = issueLocation(issue);
    const loc = location ? ` (\`${location}\`)` : "";
    const tag = `\`${ISSUE_SEVERITY_TAG[issue.severity]}\``;
    return `- ${tag} **${issue.title}**${loc}\n  ${issue.description}`;
  });
  return ["### Walkthrough issues", ...lines].join("\n\n");
}

export interface PostedThread {
  threadId: string;
  draftIds: readonly string[];
  comment: GhCommentAnchor;
}

export interface SkippedComment {
  threadId: string;
  path: string;
  line: number;
  reason: string;
}

/**
 * The review comments the chosen threads post (see `planThreadComment`), each
 * carrying only what `messagesInReview` lets a review carry. One GitHub can't
 * take would make it reject the whole review, so it stays a local draft, named
 * in `skippedComments`.
 */
export function planReviewComments(
  { threads, messages }: Conversation,
  chosen: { readonly threadIds: ReadonlySet<string>; readonly issueIds: ReadonlySet<string> },
  cachedFiles: readonly CachedDiffFile[] | null,
  viewerLogin: string | null,
): { posted: PostedThread[]; skippedComments: SkippedComment[] } {
  const posted: PostedThread[] = [];
  const skippedComments: SkippedComment[] = [];
  for (const thread of threads) {
    if (!chosen.threadIds.has(thread.id)) continue;
    const carried = messagesInReview(thread, messages[thread.id] ?? [], chosen.issueIds);
    const plan = planThreadComment(thread, carried, viewerLogin, cachedFiles);
    if (plan === null) continue;
    if (plan.kind === "skip") {
      skippedComments.push({
        threadId: thread.id,
        path: thread.filePath,
        line: thread.endLine,
        reason: plan.reason,
      });
      continue;
    }
    posted.push({ threadId: thread.id, draftIds: plan.draftIds, comment: plan.comment });
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
    Effect.sync(() => logError("review-submit", `${what}:`, e.message ?? e));

/**
 * Post the review to GitHub, its line comments built from the chosen draft
 * threads, then bring the local review in line with what GitHub now holds:
 * each posted thread is linked to its GitHub comment (so neither it nor its
 * drafts is ever posted again), the signed-in user's pending replies on the
 * chosen threads GitHub already has go up, and the PR's threads are pulled back.
 */
export function submitReview(prId: string, body: SubmitReviewInput) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const github = yield* GitHubGateway;
    const review = yield* ReviewService;
    const sync = yield* SyncService;
    const walkthroughService = yield* WalkthroughService;
    const diffCache = yield* DiffCacheService;
    const conversations = yield* PrConversationService;

    const ctx = yield* prContext.forPr(prId);
    const { pr, repo, client, accountId } = ctx;
    const viewerLogin = yield* Effect.flatMap(GitHubAccounts, (a) => a.viewerLogin(accountId));

    const eventMap = {
      approve: "APPROVE",
      request_changes: "REQUEST_CHANGES",
      comment: "COMMENT",
    } as const;

    const issues = yield* walkthroughService.issuesOnPr(pr.id, body.issueIds ?? []);
    const issueIds = issues.map((issue) => issue.id);
    const chosenIssueIds: ReadonlySet<string> = new Set(issueIds);

    const chosenThreadIds: ReadonlySet<string> = new Set(body.threadIds ?? []);
    const before = yield* review.getConversation(pr.id);
    const cachedFiles = yield* diffCache.getCachedFiles(pr.id);
    const { posted, skippedComments } = planReviewComments(
      before,
      { threadIds: chosenThreadIds, issueIds: chosenIssueIds },
      cachedFiles,
      viewerLogin,
    );
    // Replies on chosen threads GitHub already has. A submit never touches
    // those threads' rows before the replies go up.
    const replies = before.threads
      .filter((t) => chosenThreadIds.has(t.id))
      .flatMap((t) =>
        unpublishedReplies(
          t,
          messagesInReview(t, before.messages[t.id] ?? [], chosenIssueIds),
          viewerLogin,
        ),
      );
    const reviewInput = {
      event: eventMap[body.action],
      body: reviewBody(issues),
      comments: posted.map((p) => p.comment),
    };

    // GitHub 422s a bodyless COMMENT / REQUEST_CHANGES review. Say why here
    // instead of relaying that; a comment review made only of replies posts
    // the replies with no review around them.
    const reviewIsEmpty = reviewInput.comments.length === 0 && reviewInput.body.trim() === "";
    if (body.action !== "approve" && reviewIsEmpty) {
      if (skippedComments.length > 0) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Nothing to submit: ${skippedComments.length === 1 ? "the comment's line is" : "every comment's line is"} no longer part of the diff.`,
          }),
        );
      }
      if (body.action === "request_changes" || replies.length === 0) {
        return yield* Effect.fail(
          new ValidationError({
            message:
              body.action === "request_changes"
                ? "Requesting changes needs an issue or a line comment."
                : "Nothing to submit.",
          }),
        );
      }
    }

    const submitReviewToGitHub = github.reviews
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
    const submitted =
      body.action !== "approve" && reviewIsEmpty ? null : yield* submitReviewToGitHub;

    // GitHub's review response carries no per-comment ids, so each posted
    // thread is matched back to one of the review's comments.
    if (submitted !== null && posted.length > 0) {
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

    const failedReplies = yield* sync.pushReplies(replies.map((reply) => reply.id));

    yield* sync.syncThreadsNow(pr.id);

    // Stamped regardless of action: an approve whose body includes walkthrough
    // issues also counts as "sent to GitHub".
    const issuesSubmittedAt =
      issueIds.length > 0 ? yield* walkthroughService.markIssuesSubmitted(issueIds) : null;

    const { conversation } = yield* conversations.afterWrite(ctx);

    return {
      id: submitted?.id ?? null,
      htmlUrl: submitted?.htmlUrl ?? null,
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
