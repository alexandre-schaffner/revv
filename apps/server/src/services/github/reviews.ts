/** Pull-request reviews, review comments and review threads on GitHub. */
import { Effect } from "effect";
import { type GitHubError, GitHubNotFoundError } from "../../domain/errors";
import { splitFullName } from "./graphql-batch";
import {
  type GitHubClient,
  type GitHubHttp,
  type GraphqlConnection,
  paginateGraphql,
  retryTransient,
} from "./transport";

export interface GhReviewComment {
  readonly id: number;
  readonly inReplyToId: number | null;
  readonly path: string;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
  readonly authorLogin: string;
  readonly authorAvatarUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
}

export interface GhReviewThread {
  readonly nodeId: string;
  readonly isResolved: boolean;
  readonly commentDatabaseIds: ReadonlyArray<number>;
}

/** A line-anchored comment as GitHub's review and comment endpoints take it. */
export interface GhCommentAnchor {
  readonly path: string;
  readonly body: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly startLine?: number;
  readonly startSide?: "LEFT" | "RIGHT";
}

function anchorPayload(c: GhCommentAnchor): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    path: c.path,
    body: c.body,
    line: c.line,
    side: c.side,
  };
  if (c.startLine !== undefined && c.startLine !== c.line) {
    payload.start_line = c.startLine;
    payload.start_side = c.startSide ?? c.side;
  }
  return payload;
}

function created(raw: unknown): { id: number; htmlUrl: string; createdAt: string } {
  const r = raw as Record<string, unknown>;
  return {
    id: r.id as number,
    htmlUrl: (r.html_url as string | undefined) ?? "",
    createdAt: (r.created_at as string | undefined) ?? new Date().toISOString(),
  };
}

const reviewThreadsQuery = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 100) { nodes { databaseId } }
          }
        }
      }
    }
  }
`;

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: { nodes: Array<{ databaseId: number }> };
}

interface ReviewThreadsResp {
  repository: {
    pullRequest: { reviewThreads: GraphqlConnection<ReviewThreadNode> } | null;
  } | null;
}

export const reviewsApi = (http: GitHubHttp) => {
  const prPath = (owner: string, repo: string, prNumber: number) =>
    `/repos/${owner}/${repo}/pulls/${prNumber}`;

  return {
    submit: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
      review: {
        readonly body: string;
        readonly event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
        readonly comments: ReadonlyArray<GhCommentAnchor>;
      },
    ): Effect.Effect<{ id: number; htmlUrl: string }, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const raw = yield* http.json(client, {
          method: "POST",
          path: `${prPath(owner, repo, prNumber)}/reviews`,
          body: {
            event: review.event,
            body: review.body,
            ...(review.comments.length > 0 ? { comments: review.comments.map(anchorPayload) } : {}),
          },
        });
        const { id, htmlUrl } = created(raw);
        return { id, htmlUrl };
      }),

    findPending: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
      reviewerLogin: string,
    ): Effect.Effect<{ id: number; htmlUrl: string } | null, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const data = yield* http.pages(
          client,
          `${prPath(owner, repo, prNumber)}/reviews?per_page=100`,
          { maxPages: 10 },
        );
        const pending = (data as Record<string, unknown>[])
          .filter((raw) => {
            const user = raw.user as Record<string, unknown> | null | undefined;
            return raw.state === "PENDING" && user?.login === reviewerLogin;
          })
          .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))[0];
        if (!pending) return null;
        return {
          id: pending.id as number,
          htmlUrl: (pending.html_url as string | undefined) ?? "",
        };
      }),

    deletePending: (client: GitHubClient, fullName: string, prNumber: number, reviewId: number) =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        yield* http.json(client, {
          method: "DELETE",
          path: `${prPath(owner, repo, prNumber)}/reviews/${reviewId}`,
        });
      }),

    commentsForReview: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
      reviewId: number,
    ): Effect.Effect<
      Array<{
        id: number;
        path: string;
        line: number | null;
        originalLine: number | null;
        body: string;
      }>,
      GitHubError
    > =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const data = yield* http.json(client, {
          path: `${prPath(owner, repo, prNumber)}/reviews/${reviewId}/comments`,
        });
        return ((data ?? []) as Array<Record<string, unknown>>).map((c) => ({
          id: c.id as number,
          path: c.path as string,
          line: (c.line as number | null | undefined) ?? null,
          originalLine: (c.original_line as number | null | undefined) ?? null,
          body: c.body as string,
        }));
      }),

    createComment: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
      comment: GhCommentAnchor & { readonly commitSha: string },
    ): Effect.Effect<{ id: number; htmlUrl: string; createdAt: string }, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const raw = yield* http.json(client, {
          method: "POST",
          path: `${prPath(owner, repo, prNumber)}/comments`,
          body: { ...anchorPayload(comment), commit_id: comment.commitSha },
        });
        return created(raw);
      }),

    replyToComment: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
      commentId: string | number,
      body: string,
    ): Effect.Effect<{ id: number; htmlUrl: string; createdAt: string }, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const raw = yield* http.json(client, {
          method: "POST",
          path: `${prPath(owner, repo, prNumber)}/comments/${commentId}/replies`,
          body: { body },
        });
        return created(raw);
      }),

    /**
     * The PR's review comments, conditional: this is the per-PR REST call the
     * thread sweep makes for every open PR, and a 304 does not count against
     * the REST primary limit, so quiet PRs are free. The cache key folds in
     * `since`, which only advances when new comments arrive. A 304 replays
     * the cached list only when it was a single (<100) page.
     */
    listComments: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
      since: string | null,
    ): Effect.Effect<GhReviewComment[], GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const sinceQ = since ? `&since=${encodeURIComponent(since)}` : "";
        const data = yield* http.pages(
          client,
          `${prPath(owner, repo, prNumber)}/comments?per_page=100${sinceQ}`,
          { maxPages: 5, canReplayCached: (cached) => cached.length < 100 },
        );
        return (data as Record<string, unknown>[]).map((raw): GhReviewComment => {
          const user = (raw.user as Record<string, unknown> | null) ?? {};
          return {
            id: raw.id as number,
            inReplyToId: (raw.in_reply_to_id as number | undefined) ?? null,
            path: raw.path as string,
            line: (raw.line as number | null) ?? (raw.original_line as number | null) ?? null,
            startLine: (raw.start_line as number | null) ?? null,
            side: (raw.side as "LEFT" | "RIGHT" | undefined) ?? "RIGHT",
            body: (raw.body as string | undefined) ?? "",
            authorLogin: (user.login as string | undefined) ?? "",
            authorAvatarUrl: (user.avatar_url as string | undefined) ?? null,
            createdAt: raw.created_at as string,
            updatedAt: raw.updated_at as string,
            htmlUrl: (raw.html_url as string | undefined) ?? "",
          };
        });
      }).pipe(retryTransient),

    listThreads: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
    ): Effect.Effect<GhReviewThread[], GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const nodes = yield* paginateGraphql<ReviewThreadsResp, ReviewThreadNode>(http, client, {
          query: reviewThreadsQuery,
          variables: { owner, repo, number: prNumber },
          selectConnection: (data) => data.repository?.pullRequest?.reviewThreads,
          maxPages: 5,
          notFound: () =>
            new GitHubNotFoundError({ resource: "pull_request", id: `${fullName}#${prNumber}` }),
        });
        return nodes.map(
          (node): GhReviewThread => ({
            nodeId: node.id,
            isResolved: node.isResolved,
            commentDatabaseIds: node.comments.nodes.map((n) => n.databaseId),
          }),
        );
      }).pipe(retryTransient),

    resolveThread: (client: GitHubClient, threadNodeId: string) =>
      http
        .graphql(
          client,
          `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }`,
          { id: threadNodeId },
        )
        .pipe(Effect.asVoid),

    unresolveThread: (client: GitHubClient, threadNodeId: string) =>
      http
        .graphql(
          client,
          `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { clientMutationId } }`,
          { id: threadNodeId },
        )
        .pipe(Effect.asVoid),
  };
};
