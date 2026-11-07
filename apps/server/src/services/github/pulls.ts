import type { MergeEligibility, MergeMethod, PrStackPlace, PullRequest } from "@revv/shared";
import { Effect } from "effect";
import { type GitHubError, GitHubNotFoundError } from "../../domain/errors";
import {
  localPrId,
  type ObservedPr,
  STACK_UNSEEN,
  type StackSighting,
  stackSeen,
} from "../../domain/observed-pr";
import { logError } from "../../logger";
import { prsByNumber, reposByName, splitFullName } from "./graphql-batch";
import { STACK_SCHEMA_TOKENS } from "./stack-queries";
import {
  type GitHubClient,
  type GitHubHttp,
  type GraphqlConnection,
  paginateGraphql,
  retryTransient,
  retryTransientBeforeFallback,
  withSchemaFallback,
} from "./transport";

/** What every PR read carries, whichever API it came from. */
interface PrFields {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  /** `null` for a deleted account. */
  readonly authorLogin: string | null;
  readonly authorAvatarUrl: string | null;
  readonly requestedReviewers: string[];
  readonly status: PullRequest["status"];
  readonly isDraft: boolean;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly url: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

function toObservedPr(
  fields: PrFields,
  repositoryId: string,
  stack: StackSighting,
  sized: boolean,
): ObservedPr {
  return {
    ...fields,
    ...(sized ? { statsHeadSha: fields.headSha } : {}),
    id: localPrId(repositoryId, fields.number),
    externalId: fields.number,
    repositoryId,
    // REST reports an empty description as null; GraphQL as "".
    body: fields.body || null,
    // A deleted account is GitHub's `ghost` user.
    authorLogin: fields.authorLogin ?? "ghost",
    authorAvatarContent: null,
    // GitHub's PR payloads have no mentions field; they're parsed out of the
    // body and comments during sync.
    mentionedUsers: [],
    reviewStatus: "pending",
    fetchedAt: new Date().toISOString(),
    stack,
  };
}

function restPrFields(raw: Record<string, unknown>): PrFields {
  const user = raw.user as Record<string, unknown> | null;
  const head = raw.head as Record<string, unknown>;
  const base = raw.base as Record<string, unknown>;
  const reviewers = (raw.requested_reviewers as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    number: raw.number as number,
    title: raw.title as string,
    body: (raw.body as string | null) ?? null,
    authorLogin: (user?.login as string | undefined) ?? null,
    authorAvatarUrl: (user?.avatar_url as string | null | undefined) ?? null,
    requestedReviewers: reviewers.map((r) => r.login as string),
    status: raw.state === "closed" ? (raw.merged_at ? "merged" : "closed") : "open",
    isDraft: (raw.draft as boolean | undefined) ?? false,
    sourceBranch: head.ref as string,
    targetBranch: base.ref as string,
    url: raw.html_url as string,
    additions: (raw.additions as number | undefined) ?? 0,
    deletions: (raw.deletions as number | undefined) ?? 0,
    changedFiles: (raw.changed_files as number | undefined) ?? 0,
    headSha: head.sha as string,
    baseSha: base.sha as string,
    createdAt: raw.created_at as string,
    updatedAt: raw.updated_at as string,
    closedAt: (raw.closed_at as string | null) ?? null,
  };
}

interface GqlActor {
  readonly __typename: string;
  readonly login?: string;
  readonly avatarUrl?: string | null;
}

/**
 * The login REST would report for a GraphQL actor. REST names an app account
 * `dependabot[bot]`; GraphQL's `Bot.login` drops the suffix. Every other login
 * in the DB came from REST, so the suffix is restored here or bot PRs would
 * fall out of author filters and matching.
 */
function restLogin(actor: GqlActor): string | null {
  if (!actor.login) return null;
  return actor.__typename === "Bot" ? `${actor.login}[bot]` : actor.login;
}

// Exactly the fields `graphqlPrFields` reads. `additions`/`deletions`/
// `changedFiles` are left out of the open list on purpose: GitHub computes
// them per PR, which made the list ~20% slower, and `diffStats` fetches them
// for the PRs that need them.
const PR_NODE_FIELDS = `
  number title body isDraft url createdAt updatedAt closedAt
  headRefName baseRefName headRefOid baseRefOid
  author { __typename login avatarUrl }
  reviewRequests(first: 100) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Bot { login }
        ... on Mannequin { login }
      }
    }
  }`;

interface GqlPr {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly isDraft: boolean;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly baseRefOid: string;
  readonly author: GqlActor | null;
  readonly stack?: { readonly number: number } | null;
  readonly stackEntry?: { readonly position: number } | null;
  readonly reviewRequests: {
    readonly nodes: ReadonlyArray<{ readonly requestedReviewer: GqlActor | null } | null>;
  };
  readonly state?: "OPEN" | "CLOSED" | "MERGED";
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
}

function graphqlPrFields(node: GqlPr): PrFields {
  return {
    number: node.number,
    title: node.title,
    body: node.body,
    authorLogin: node.author ? restLogin(node.author) : null,
    authorAvatarUrl: node.author?.avatarUrl ?? null,
    // Team requests have no login; REST lists them separately too.
    requestedReviewers: node.reviewRequests.nodes.flatMap((n) => {
      const login = n?.requestedReviewer ? restLogin(n.requestedReviewer) : null;
      return login ? [login] : [];
    }),
    status: node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : "open",
    isDraft: node.isDraft,
    sourceBranch: node.headRefName,
    targetBranch: node.baseRefName,
    url: node.url,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    headSha: node.headRefOid,
    baseSha: node.baseRefOid,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
  };
}

function stackPlaceOf(node: GqlPr): PrStackPlace | null {
  return node.stack && node.stackEntry
    ? { number: node.stack.number, position: node.stackEntry.position }
    : null;
}

/**
 * A few active repos exceed 1,000 open PRs. Bounded for rate-limit safety, but
 * well past the point where a team filter would need rows GitHub's first pages
 * didn't return.
 */
const OPEN_PRS_MAX_PAGES = 50;

export const OPEN_PRS_PAGE_SIZE = 100;

export const OPEN_PRS_LIST_CAP = OPEN_PRS_MAX_PAGES * OPEN_PRS_PAGE_SIZE;

const openPrsQuery = (
  withStacks: boolean,
) => `query OpenPullRequests($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${OPEN_PRS_PAGE_SIZE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PR_NODE_FIELDS}
        ${withStacks ? "stack { number } stackEntry { position }" : ""}
      }
    }
  }
}`;

interface OpenPrsResp {
  readonly repository: { readonly pullRequests: GraphqlConnection<GqlPr> } | null;
}

export interface OpenPrList {
  readonly prs: ObservedPr[];
  readonly hostPredatesStacks: boolean;
}

const closedPrsQuery = `query ClosedPullRequestsSince($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [CLOSED, MERGED], first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number updatedAt }
    }
  }
}`;

interface ClosedPrNode {
  readonly number: number;
  readonly updatedAt: string;
}

interface ClosedPrsResp {
  readonly repository: { readonly pullRequests: GraphqlConnection<ClosedPrNode> } | null;
}

const CLOSED_SINCE_MAX_PAGES = 5;

/**
 * What a repo's open-PR list looks like from the outside: how many there are,
 * and when the most recently updated one last moved.
 *
 * Opening, closing, merging or reopening a PR moves the count or the newest
 * `updatedAt`; a push, edit, draft flip or reviewer request bumps the PR's
 * `updatedAt` and so the newest one. So an unchanged signature means a fresh
 * list would carry nothing the DB doesn't already have — except for the few
 * fields GitHub changes without bumping `updatedAt` (a base branch advancing),
 * which is why callers still re-list on a slower clock.
 */
export interface OpenPrListSignature {
  readonly count: number;
  /** `null` when the repo has no open PRs. */
  readonly latestUpdatedAt: string | null;
}

/** The signature of a list already in hand, comparable with a probed one. */
export function signatureOfList(prs: readonly PullRequest[]): OpenPrListSignature {
  let latestUpdatedAt: string | null = null;
  for (const pr of prs) {
    if (latestUpdatedAt === null || pr.updatedAt > latestUpdatedAt) latestUpdatedAt = pr.updatedAt;
  }
  return { count: prs.length, latestUpdatedAt };
}

export function sameSignature(a: OpenPrListSignature, b: OpenPrListSignature): boolean {
  return a.count === b.count && a.latestUpdatedAt === b.latestUpdatedAt;
}

interface SignatureNode {
  readonly pullRequests: {
    readonly totalCount: number;
    readonly nodes: ReadonlyArray<{ readonly updatedAt: string } | null>;
  };
}

const PR_DETAIL_FIELDS = `${PR_NODE_FIELDS}
  mergedAt state additions deletions changedFiles`;

const PR_DETAIL_CHUNK = 50;
const DIFF_STATS_CHUNK = 100;

export interface PrDiffStats {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

export interface PrFileMeta {
  readonly filename: string;
  readonly previousFilename: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}

const PR_FILES_PAGE_SIZE = 100;
export const PR_FILES_MAX_PAGES = 30;
export const PR_FILES_MAX_COUNT = PR_FILES_PAGE_SIZE * PR_FILES_MAX_PAGES;
/**
 * Hard cap on `files[]` from GitHub's compare endpoint. Unlike `/pulls/:n/files`
 * this endpoint does not paginate the file list, so a range touching more than
 * 300 files comes back truncated.
 */
const COMPARE_FILES_MAX_COUNT = 300;

function fileMeta(f: Record<string, unknown>): PrFileMeta {
  return {
    filename: f.filename as string,
    previousFilename: (f.previous_filename as string | undefined) ?? null,
    status: f.status as string,
    additions: (f.additions as number | undefined) ?? 0,
    deletions: (f.deletions as number | undefined) ?? 0,
    patch: (f.patch as string | undefined) ?? null,
  };
}

/**
 * Collapse repeated filenames in GitHub's PR-files list.
 *
 * GitHub emits *two* entries for one path when the file's type changed — a
 * regular file replaced by a symlink comes back as a `removed` entry
 * immediately followed by an `added` entry, both with the same `filename`.
 * `pr_diff_files` is keyed on `(prId, path)`, so the pair would collapse on
 * write and the stored count never reach GitHub's `changed_files`; and
 * `@pierre/trees` throws `Duplicate path` on a list naming a path twice.
 *
 * Last entry wins, matching the cache write's `onConflictDoUpdate`; the
 * surviving entry keeps the first occurrence's position.
 */
export function dedupePrFilesByPath(files: readonly PrFileMeta[]): PrFileMeta[] {
  const byPath = new Map<string, PrFileMeta>();
  for (const file of files) byPath.set(file.filename, file);
  return [...byPath.values()];
}

export interface PrCommit {
  readonly sha: string;
  readonly message: string;
  readonly authorLogin: string | null;
  readonly authorAvatarUrl: string | null;
  readonly date: string | null;
}

/**
 * Order commits head → oldest by walking the first-parent chain. GitHub's
 * "order they appear on the branch" is not stable across force-pushes,
 * cherry-picks and unusual merge histories.
 */
function orderByFirstParent(
  raw: ReadonlyArray<PrCommit & { readonly parents: readonly string[] }>,
): PrCommit[] {
  const byHash = new Map(raw.map((c) => [c.sha, c]));
  const inRange = new Set(raw.map((c) => c.sha));
  const isParentInRange = new Set<string>();
  for (const c of raw) {
    for (const p of c.parents) if (inRange.has(p)) isParentInRange.add(p);
  }
  const ordered: Array<(typeof raw)[number]> = [];
  const visited = new Set<string>();
  let current = raw.find((c) => !isParentInRange.has(c.sha));
  while (current && !visited.has(current.sha)) {
    visited.add(current.sha);
    ordered.push(current);
    const firstParent = current.parents[0];
    current = firstParent ? byHash.get(firstParent) : undefined;
  }
  // Disconnected merge histories: keep the unreached commits visible.
  for (const c of raw) if (!visited.has(c.sha)) ordered.push(c);
  return ordered.map(({ sha, message, authorLogin, authorAvatarUrl, date }) => ({
    sha,
    message,
    authorLogin,
    authorAvatarUrl,
    date,
  }));
}

export interface ClosedInWindow {
  readonly number: number;
  readonly closedAt: string;
  readonly merged: boolean;
}

// The Search API caps a query at 1000 results: 10 pages of 100.
const SEARCH_MAX_PAGES = 10;

function prNotFound(fullName: string, prNumber: number): GitHubNotFoundError {
  return new GitHubNotFoundError({ resource: "pull_request", id: `${fullName}#${prNumber}` });
}

export const pullsApi = (http: GitHubHttp) => {
  /**
   * Look up a PR's GraphQL node id, the only handle the draft-toggle
   * mutations accept.
   */
  const nodeId = (client: GitHubClient, fullName: string, prNumber: number) =>
    Effect.gen(function* () {
      const { owner, repo } = yield* splitFullName(fullName);
      const data = yield* http.graphql<{
        repository: { pullRequest: { id: string } | null } | null;
      }>(
        client,
        `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
        }`,
        { owner, repo, number: prNumber },
      );
      const id = data.repository?.pullRequest?.id;
      if (!id) return yield* Effect.fail(prNotFound(fullName, prNumber));
      return id;
    });

  const mutatePr = (client: GitHubClient, fullName: string, prNumber: number, mutation: string) =>
    Effect.gen(function* () {
      const id = yield* nodeId(client, fullName, prNumber);
      yield* http.graphql(
        client,
        `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id },
      );
    });

  return {
    /**
     * Every open PR of one repo, most recently updated first.
     *
     * GraphQL, not `GET /pulls`: the REST list embeds two full repository
     * objects per PR (~20 KB each), and on GitHub Enterprise its ETag never
     * matches — every author's `avatar_url` carries a per-request signed
     * token. This asks for the list fields only at 1 GraphQL point per 100 PRs.
     *
     * Diff sizes are left at 0/0/0; `diffStats` fills them in for the PRs
     * whose head moved. Stack membership comes along unless `withStacks` is
     * false or GitHub won't give it, when each PR's `stack` is `STACK_UNSEEN`.
     */
    listOpen: (
      client: GitHubClient,
      fullName: string,
      repositoryId: string,
      {
        withStacks = true,
        updatedSince = null,
      }: {
        readonly withStacks?: boolean;
        readonly updatedSince?: string | null;
      } = {},
    ): Effect.Effect<OpenPrList, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const recent = (node: { readonly updatedAt: string }) =>
          updatedSince === null || node.updatedAt >= updatedSince;
        const list = (asked: boolean) =>
          paginateGraphql<OpenPrsResp, GqlPr>(http, client, {
            query: openPrsQuery(asked),
            variables: { owner, name: repo },
            selectConnection: (data) => data.repository?.pullRequests,
            maxPages: OPEN_PRS_MAX_PAGES,
            notFound: () => new GitHubNotFoundError({ resource: "repo", id: fullName }),
            stopAfter: (page) => page.some((node) => !recent(node)),
          }).pipe(
            Effect.map((nodes) =>
              nodes
                .filter(recent)
                .map((node) =>
                  toObservedPr(
                    graphqlPrFields(node),
                    repositoryId,
                    asked ? stackSeen(stackPlaceOf(node)) : STACK_UNSEEN,
                    false,
                  ),
                ),
            ),
          );
        if (!withStacks) {
          const prs = yield* list(false).pipe(retryTransient);
          return { prs, hostPredatesStacks: false };
        }
        // Stacks are garnish on the poll's most important request, so any
        // failure GraphQL answers earns one ask without them: a host that
        // predates them, a FORBIDDEN on one PR's stack, or a query the stack
        // fields tipped into a timeout. HTTP, auth, rate-limit and network
        // failures hit both shapes alike and fail as is.
        const { value, outdated } = yield* withSchemaFallback(
          (modern) =>
            modern
              ? list(true).pipe(retryTransientBeforeFallback)
              : list(false).pipe(retryTransient),
          STACK_SCHEMA_TOKENS,
          { anyGraphqlFailure: true },
        );
        return { prs: value, hostPredatesStacks: outdated };
      }),

    /**
     * Numbers of the PRs that closed or merged at or after `since` — what a
     * `listOpen` read with `updatedSince` can't see. Null when they didn't fit
     * in the pages allowed, which means "unknown", never "none".
     */
    listClosedSince: (
      client: GitHubClient,
      fullName: string,
      since: string,
    ): Effect.Effect<number[] | null, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const recent = (node: ClosedPrNode) => node.updatedAt >= since;
        const nodes = yield* paginateGraphql<ClosedPrsResp, ClosedPrNode>(http, client, {
          query: closedPrsQuery,
          variables: { owner, name: repo },
          selectConnection: (data) => data.repository?.pullRequests,
          maxPages: CLOSED_SINCE_MAX_PAGES,
          notFound: () => new GitHubNotFoundError({ resource: "repo", id: fullName }),
          stopAfter: (page) => page.some((node) => !recent(node)),
        });
        const last = nodes[nodes.length - 1];
        if (last && recent(last) && nodes.length >= CLOSED_SINCE_MAX_PAGES * 100) return null;
        return nodes.filter(recent).map((node) => node.number);
      }).pipe(retryTransient),

    /**
     * `listOpen` over REST's `GET /pulls`, for when the GraphQL budget is
     * spent. Heavier per changed page, but conditional: a 304 costs nothing
     * against the REST limit (except on GitHub Enterprise, whose signed avatar
     * URLs defeat the ETag).
     */
    listOpenRest: (
      client: GitHubClient,
      fullName: string,
      repositoryId: string,
    ): Effect.Effect<ObservedPr[], GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const data = yield* http.pages(
          client,
          `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
          {
            maxPages: 50,
            // Sorted by updated_at desc, so any new or changed PR changes page
            // 1's ETag: replaying a 304 is safe however many pages there are.
            canReplayCached: () => true,
          },
        );
        return (data as Record<string, unknown>[]).map((raw) =>
          toObservedPr(restPrFields(raw), repositoryId, STACK_UNSEEN, false),
        );
      }).pipe(retryTransient),

    /**
     * The open-list signature of many repos (same host, same token) in one
     * request. GitHub bills a query by the connection pages it could return,
     * so 80 aliased `first: 1` connections are 1 point where listing those
     * repos is at least 80. Repos GitHub can't resolve are absent: "unknown",
     * never "unchanged".
     */
    probeOpenLists: (
      client: GitHubClient,
      fullNames: readonly string[],
    ): Effect.Effect<Map<string, OpenPrListSignature>, GitHubError> =>
      reposByName<SignatureNode>(
        http,
        client,
        "OpenPrListSignatures",
        fullNames,
        "pullRequests(states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { updatedAt } }",
      ).pipe(
        Effect.map(
          (nodes) =>
            new Map(
              [...nodes].map(([fullName, node]): [string, OpenPrListSignature] => [
                fullName,
                {
                  count: node.pullRequests.totalCount,
                  latestUpdatedAt: node.pullRequests.nodes[0]?.updatedAt ?? null,
                },
              ]),
            ),
        ),
        retryTransient,
      ),

    /** One PR's detail, conditional (a 304 is free), with its diff size. */
    get: (
      client: GitHubClient,
      fullName: string,
      repositoryId: string,
      prNumber: number,
    ): Effect.Effect<ObservedPr, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const raw = yield* http.conditional(client, `/repos/${owner}/${repo}/pulls/${prNumber}`);
        return toObservedPr(
          restPrFields(raw as Record<string, unknown>),
          repositoryId,
          STACK_UNSEEN,
          true,
        );
      }).pipe(retryTransient),

    /**
     * Many PRs of one repo by number, any state, with their diff size, in one
     * GraphQL request per 50. Absent from the map when GitHub couldn't say.
     */
    getMany: (
      client: GitHubClient,
      fullName: string,
      repositoryId: string,
      prNumbers: readonly number[],
    ): Effect.Effect<Map<number, ObservedPr>, GitHubError> =>
      prsByNumber<GqlPr>(
        http,
        client,
        "PrDetails",
        fullName,
        prNumbers,
        PR_DETAIL_FIELDS,
        PR_DETAIL_CHUNK,
      ).pipe(
        Effect.map(
          (nodes) =>
            new Map(
              [...nodes].map(([n, node]): [number, ObservedPr] => [
                n,
                toObservedPr(graphqlPrFields(node), repositoryId, STACK_UNSEEN, true),
              ]),
            ),
        ),
        retryTransient,
      ),

    /**
     * Diff size for many PRs of one repo, keyed by PR number: one aliased
     * GraphQL request per 100, for just the PRs that need it. A PR GitHub
     * couldn't resolve is absent — "unknown", never zero (see the
     * `changed_files > 0` guard in `PullRequestService.upsertPrs`).
     */
    diffStats: (
      client: GitHubClient,
      fullName: string,
      prNumbers: readonly number[],
    ): Effect.Effect<Map<number, PrDiffStats>, GitHubError> =>
      prNumbers.length === 0
        ? Effect.succeed(new Map())
        : prsByNumber<PrDiffStats>(
            http,
            client,
            "PrDiffStats",
            fullName,
            prNumbers,
            "additions deletions changedFiles",
            DIFF_STATS_CHUNK,
          ).pipe(retryTransient),

    /**
     * PRs closed (or merged) in a time window, through the issue-search API —
     * how the recap finds PRs that never made it into the local mirror.
     */
    searchClosedInWindow: (
      client: GitHubClient,
      fullName: string,
      sinceIso: string,
      untilIso: string,
    ): Effect.Effect<ReadonlyArray<ClosedInWindow>, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const q = `repo:${owner}/${repo} is:pr is:closed closed:${sinceIso}..${untilIso}`;
        const collected: ClosedInWindow[] = [];
        for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
          const params = new URLSearchParams({
            q,
            per_page: "100",
            sort: "updated",
            order: "desc",
            page: String(page),
          });
          const body = ((yield* http.json(client, { path: `/search/issues?${params}` })) ?? {}) as {
            items?: unknown;
          };
          const items = Array.isArray(body.items) ? body.items : [];
          for (const raw of items) {
            if (raw === null || typeof raw !== "object") continue;
            const item = raw as Record<string, unknown>;
            if (typeof item.number !== "number" || typeof item.closed_at !== "string") continue;
            const prMeta = item.pull_request as Record<string, unknown> | null | undefined;
            collected.push({
              number: item.number,
              closedAt: item.closed_at,
              merged: typeof prMeta?.merged_at === "string",
            });
          }
          if (items.length < 100) break;
        }
        return collected;
      }).pipe(retryTransient),

    files: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
    ): Effect.Effect<PrFileMeta[], GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        // Walk the endpoint's full supported range so a large PR doesn't
        // cache an incomplete file list.
        const data = yield* http.pages(
          client,
          `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${PR_FILES_PAGE_SIZE}`,
          { maxPages: PR_FILES_MAX_PAGES },
        );
        return dedupePrFilesByPath((data as Record<string, unknown>[]).map(fileMeta));
      }).pipe(retryTransient),

    /**
     * Files changed between two refs, as a three-dot (merge-base) comparison,
     * in the same shape and hunks-only `patch` format as `files`. Conditional,
     * so a repeat visit to the same range is free.
     *
     * Compare caps `files[]` at 300 entries with no pagination; a wider range
     * is truncated by GitHub with no signal, so the cap is logged.
     */
    compareFiles: (
      client: GitHubClient,
      fullName: string,
      baseRef: string,
      headRef: string,
    ): Effect.Effect<PrFileMeta[], GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const data = yield* http.conditional(
          client,
          `/repos/${owner}/${repo}/compare/${baseRef}...${headRef}`,
        );
        const rawFiles =
          ((data as Record<string, unknown>).files as Record<string, unknown>[] | undefined) ?? [];
        if (rawFiles.length >= COMPARE_FILES_MAX_COUNT) {
          logError(
            "github",
            `compare ${fullName} ${baseRef}...${headRef} hit the ${COMPARE_FILES_MAX_COUNT}-file compare cap; the ranged file list is truncated`,
          );
        }
        return dedupePrFilesByPath(rawFiles.map(fileMeta));
      }).pipe(retryTransient),

    /** The PR's commits, head first. GitHub returns at most 250; 3 pages of 100 cover them. */
    commits: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
    ): Effect.Effect<PrCommit[], GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        const data = yield* http.pages(
          client,
          `/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`,
          { maxPages: 3 },
        );
        return orderByFirstParent(
          (data as Record<string, unknown>[]).map((c) => {
            const commit = c.commit as Record<string, unknown>;
            const author = c.author as Record<string, unknown> | null;
            const commitAuthor = commit.author as Record<string, unknown> | null;
            const parents = (c.parents as Record<string, unknown>[] | undefined) ?? [];
            const message = commit.message as string;
            return {
              sha: c.sha as string,
              message: message.split("\n")[0] ?? message,
              authorLogin: author ? (author.login as string) : null,
              authorAvatarUrl: author ? ((author.avatar_url as string | null) ?? null) : null,
              date: commitAuthor ? ((commitAuthor.date as string | null) ?? null) : null,
              parents: parents.map((p) => p.sha as string),
            };
          }),
        );
      }).pipe(retryTransient),

    /** GitHub only exposes draft toggles through GraphQL, by node id. */
    convertToDraft: (client: GitHubClient, fullName: string, prNumber: number) =>
      mutatePr(client, fullName, prNumber, "convertPullRequestToDraft"),

    markReadyForReview: (client: GitHubClient, fullName: string, prNumber: number) =>
      mutatePr(client, fullName, prNumber, "markPullRequestReadyForReview"),

    close: (client: GitHubClient, fullName: string, prNumber: number) =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        yield* http.json(client, {
          method: "PATCH",
          path: `/repos/${owner}/${repo}/pulls/${prNumber}`,
          body: { state: "closed" },
        });
      }),

    /**
     * Whether the viewer can merge this PR and whether it is mergeable, from
     * GraphQL so branch-protection rules are respected. `mergeable` reads
     * false while GitHub is still computing it (`UNKNOWN`).
     */
    mergeEligibility: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
    ): Effect.Effect<MergeEligibility & { readonly computing: boolean }, GitHubError> =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        // The merge-method flags and `viewerCanMergeAsAdmin` are recent
        // additions, and GraphQL rejects the whole query on an unknown field —
        // so an older GitHub Enterprise would cost the caller `canMerge` too.
        // Ask with them; on a schema complaint, ask without. An unreported
        // method counts as allowed; without `viewerCanMergeAsAdmin`, ADMIN
        // permission stands in for it.
        const MERGE_METHOD_FIELDS = [
          "mergeCommitAllowed",
          "squashMergeAllowed",
          "rebaseMergeAllowed",
        ];
        const ADMIN_MERGE_FIELDS = ["viewerCanMergeAsAdmin"];
        const buildQuery = (withAdminMerge: boolean, withMergeMethods: boolean): string => `
          query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                mergeable
                mergeStateStatus
                ${withAdminMerge ? ADMIN_MERGE_FIELDS.join("\n") : ""}
              }
              viewerPermission
              ${withMergeMethods ? MERGE_METHOD_FIELDS.join("\n") : ""}
            }
          }
        `;
        interface Resp {
          repository: {
            pullRequest: {
              mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
              mergeStateStatus: string | null;
              viewerCanMergeAsAdmin?: boolean | null;
            } | null;
            viewerPermission: "ADMIN" | "MAINTAIN" | "WRITE" | "READ" | "NONE" | null;
            mergeCommitAllowed: boolean | null;
            squashMergeAllowed: boolean | null;
            rebaseMergeAllowed: boolean | null;
          } | null;
        }
        const ask = (withAdminMerge: boolean) =>
          withSchemaFallback(
            (withMergeMethods: boolean) =>
              http.graphql<Resp>(client, buildQuery(withAdminMerge, withMergeMethods), {
                owner,
                repo,
                number: prNumber,
              }),
            MERGE_METHOD_FIELDS,
          ).pipe(Effect.map(({ value }) => value));
        const { value: data, modern: adminMergeAsked } = yield* withSchemaFallback(
          ask,
          ADMIN_MERGE_FIELDS,
        );
        const pr = data.repository?.pullRequest;
        if (!pr) return yield* Effect.fail(prNotFound(fullName, prNumber));
        const perm = data.repository?.viewerPermission;
        // Offering a strategy the repo disabled earns a 405 from the merge
        // endpoint, so the allowed set travels with the answer.
        const allowedMethods: MergeMethod[] = [];
        if (data.repository?.mergeCommitAllowed !== false) allowedMethods.push("merge");
        if (data.repository?.squashMergeAllowed !== false) allowedMethods.push("squash");
        if (data.repository?.rebaseMergeAllowed !== false) allowedMethods.push("rebase");
        return {
          canMerge: perm === "ADMIN" || perm === "MAINTAIN" || perm === "WRITE",
          // GitHub's own answer covers bypass lists and rulesets a permission
          // level can't see; ADMIN is only the guess for hosts that can't say.
          canBypassProtections: adminMergeAsked
            ? pr.viewerCanMergeAsAdmin === true
            : perm === "ADMIN",
          mergeable: pr.mergeable === "MERGEABLE",
          mergeStateStatus: pr.mergeStateStatus ?? "unknown",
          allowedMethods,
          computing: pr.mergeable === "UNKNOWN" || pr.mergeable === null,
        };
      }),

    /**
     * Merge via REST. GitHub answers 405 when the PR is not mergeable, 422
     * when the method is disabled, and 409 when `options.sha` (the head the
     * caller saw) is no longer the head.
     */
    merge: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
      mergeMethod: MergeMethod,
      options?: { readonly sha?: string },
    ) =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        yield* http.json(client, {
          method: "PUT",
          path: `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
          body: { merge_method: mergeMethod, ...(options?.sha ? { sha: options.sha } : {}) },
        });
      }),

    updateBase: (client: GitHubClient, fullName: string, prNumber: number, base: string) =>
      Effect.gen(function* () {
        const { owner, repo } = yield* splitFullName(fullName);
        yield* http.json(client, {
          method: "PATCH",
          path: `/repos/${owner}/${repo}/pulls/${prNumber}`,
          body: { base },
        });
      }),

    /**
     * Hand a PR to GitHub's auto-merge, which merges it once its requirements
     * pass, whether or not Revv is running. `expectedHeadOid` pins it: GitHub
     * refuses, and later drops it, when the head moved.
     */
    enableAutoMerge: (
      client: GitHubClient,
      nodeId: string,
      mergeMethod: MergeMethod,
      expectedHeadOid: string,
    ) =>
      http
        .graphql(
          client,
          `mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) {
            enablePullRequestAutoMerge(
              input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }
            ) { clientMutationId }
          }`,
          { id: nodeId, method: mergeMethod.toUpperCase(), head: expectedHeadOid },
        )
        .pipe(Effect.asVoid),
  };
};
