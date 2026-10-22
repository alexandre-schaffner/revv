/**
 * The open-PR list over GraphQL, and the one-request probe that says whether
 * re-reading it could find anything new.
 *
 * Split out of `GitHub.ts`, which exposes both through `GitHubGateway.prs`.
 */
import type { PrStackPlace, PullRequest } from "@revv/shared";
import { Effect } from "effect";
import { type GitHubError, GitHubNotFoundError } from "../domain/errors";
import {
  type ObservedPr,
  STACK_UNSEEN,
  type StackSighting,
  stackSeen,
} from "../domain/observed-pr";
import {
  type GraphqlConnection,
  githubGraphqlPartial,
  paginateGraphql,
  retryTransient,
  retryTransientBeforeFallback,
  withSchemaFallback,
} from "./github-rest";

/**
 * A few active repos exceed 1,000 open PRs. Bounded for rate-limit safety, but
 * well past the point where a team filter would need rows GitHub's first pages
 * didn't return.
 */
const OPEN_PRS_MAX_PAGES = 50;

export const OPEN_PRS_PAGE_SIZE = 100;

export const OPEN_PRS_LIST_CAP = OPEN_PRS_MAX_PAGES * OPEN_PRS_PAGE_SIZE;

const STACK_TOKENS = ["PullRequestStack", "Field 'stack'", "Field 'stackEntry'"] as const;

// Exactly the fields `mapPrNode` reads. `additions`/`deletions`/`changedFiles`
// are left out on purpose: GitHub computes them per PR, which made the open
// list ~20% slower, and `listPrDiffStatsViaGraphql` already fetches them for
// the PRs that actually need them.
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

interface GqlActor {
  readonly __typename: string;
  readonly login?: string;
  readonly avatarUrl?: string | null;
}

interface GqlOpenPr {
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
}

interface OpenPrsResp {
  readonly repository: {
    readonly pullRequests: {
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      readonly nodes: ReadonlyArray<GqlOpenPr | null>;
    };
  } | null;
}

/**
 * The login REST would report for a GraphQL actor. REST names an app account
 * `dependabot[bot]`; GraphQL's `Bot.login` drops the suffix. Every other login
 * in the DB (comments, reviews, remote users) came from REST, so the suffix is
 * restored here or bot PRs would fall out of author filters and matching.
 */
function restLogin(actor: GqlActor): string | null {
  if (!actor.login) return null;
  return actor.__typename === "Bot" ? `${actor.login}[bot]` : actor.login;
}

function stackPlaceOf(node: GqlOpenPr): PrStackPlace | null {
  return node.stack && node.stackEntry
    ? { number: node.stack.number, position: node.stackEntry.position }
    : null;
}

function mapPrNode(node: GqlOpenPr, repositoryId: string, stack: StackSighting): ObservedPr {
  const requestedReviewers = node.reviewRequests.nodes.flatMap((n) => {
    // Team requests have no login; REST lists them separately too.
    const login = n?.requestedReviewer ? restLogin(n.requestedReviewer) : null;
    return login ? [login] : [];
  });
  return {
    id: `${repositoryId}:${node.number}`,
    externalId: node.number,
    repositoryId,
    title: node.title,
    // REST reports an empty description as null; GraphQL as "".
    body: node.body || null,
    // A deleted account is `null` here and the `ghost` user in REST.
    authorLogin: (node.author && restLogin(node.author)) ?? "ghost",
    authorAvatarContent: null,
    authorAvatarUrl: node.author?.avatarUrl ?? null,
    requestedReviewers,
    mentionedUsers: [],
    status: "open",
    reviewStatus: "pending",
    isDraft: node.isDraft,
    sourceBranch: node.headRefName,
    targetBranch: node.baseRefName,
    url: node.url,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headSha: node.headRefOid,
    baseSha: node.baseRefOid,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    fetchedAt: new Date().toISOString(),
    closedAt: node.closedAt,
    stack,
  };
}

export interface OpenPrList {
  readonly prs: ObservedPr[];
  readonly hostPredatesStacks: boolean;
}

export function listOpenPrsViaGraphql(
  owner: string,
  repo: string,
  repositoryId: string,
  token: string,
  apiBase: string,
  withStacks: boolean,
  updatedSince: string | null = null,
): Effect.Effect<OpenPrList, GitHubError> {
  const recent = (node: { readonly updatedAt: string }) =>
    updatedSince === null || node.updatedAt >= updatedSince;
  const list = (withStacks: boolean) =>
    paginateGraphql<OpenPrsResp, GqlOpenPr>({
      query: openPrsQuery(withStacks),
      variables: { owner, name: repo },
      selectConnection: (data) => data.repository?.pullRequests,
      maxPages: OPEN_PRS_MAX_PAGES,
      token,
      apiBase,
      notFound: () => new GitHubNotFoundError({ resource: "repo", id: `${owner}/${repo}` }),
      stopAfter: (page) => page.some((node) => !recent(node)),
    }).pipe(
      Effect.map((nodes) =>
        nodes
          .filter(recent)
          .map((node) =>
            mapPrNode(
              node,
              repositoryId,
              withStacks ? stackSeen(stackPlaceOf(node)) : STACK_UNSEEN,
            ),
          ),
      ),
    );

  if (!withStacks) {
    return list(false).pipe(
      retryTransient,
      Effect.map((prs): OpenPrList => ({ prs, hostPredatesStacks: false })),
    );
  }
  // Stacks are garnish on the poll's most important request, so any failure
  // GraphQL answers with earns one ask without them: a host that predates
  // them, but also a FORBIDDEN on one PR's stack, or a query the stack fields
  // tipped into a timeout on GitHub's side, which would otherwise stall the
  // repo's whole list for as long as it lasted. HTTP, auth, rate-limit and
  // network failures hit both shapes alike and fail as is.
  return withSchemaFallback(
    (modern) =>
      modern ? list(true).pipe(retryTransientBeforeFallback) : list(false).pipe(retryTransient),
    STACK_TOKENS,
    { anyGraphqlFailure: true },
  ).pipe(
    Effect.map(({ value, outdated }): OpenPrList => ({ prs: value, hostPredatesStacks: outdated })),
  );
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
 * The PRs of `owner/repo` that closed or merged at or after `since`: what an
 * {@link listOpenPrsViaGraphql} read with `updatedSince` can't see, since a
 * closed PR leaves the open list. Null when they didn't fit in the pages
 * allowed, which a caller must read as "unknown", never as "none".
 */
export function listClosedPrNumbersSince(
  owner: string,
  repo: string,
  token: string,
  apiBase: string,
  since: string,
): Effect.Effect<number[] | null, GitHubError> {
  const recent = (node: ClosedPrNode) => node.updatedAt >= since;
  return paginateGraphql<ClosedPrsResp, ClosedPrNode>({
    query: closedPrsQuery,
    variables: { owner, name: repo },
    selectConnection: (data) => data.repository?.pullRequests,
    maxPages: CLOSED_SINCE_MAX_PAGES,
    token,
    apiBase,
    notFound: () => new GitHubNotFoundError({ resource: "repo", id: `${owner}/${repo}` }),
    stopAfter: (page) => page.some((node) => !recent(node)),
  }).pipe(
    Effect.map((nodes) => {
      const last = nodes[nodes.length - 1];
      if (last && recent(last) && nodes.length >= CLOSED_SINCE_MAX_PAGES * 100) return null;
      return nodes.filter(recent).map((node) => node.number);
    }),
  );
}

// Many PRs of one repo, or many repos, in one request: one aliased field per
// item. GitHub answers an alias it can't resolve (PR deleted, repo renamed,
// access revoked) with `null` plus an `errors` entry, which must not cost the
// other aliases theirs; such an item is absent from the result, which callers
// read as "unknown", never as "none".

function prsByNumber<N>(
  operation: string,
  owner: string,
  repo: string,
  numbers: readonly number[],
  selection: string,
  chunkSize: number,
  token: string,
  apiBase: string,
): Effect.Effect<Map<number, N>, GitHubError> {
  return Effect.gen(function* () {
    const result = new Map<number, N>();
    for (let start = 0; start < numbers.length; start += chunkSize) {
      const chunk = numbers.slice(start, start + chunkSize);
      const argDefs = chunk.map((_, i) => `$n${i}: Int!`).join(", ");
      const fields = chunk
        .map((_, i) => `p${i}: pullRequest(number: $n${i}) { ${selection} }`)
        .join("\n");
      const variables: Record<string, string | number> = { owner, name: repo };
      chunk.forEach((n, i) => {
        variables[`n${i}`] = n;
      });
      const data = yield* githubGraphqlPartial<{ repository: Record<string, N | null> | null }>(
        `query ${operation}($owner: String!, $name: String!, ${argDefs}) {
  repository(owner: $owner, name: $name) {
${fields}
  }
}`,
        variables,
        token,
        apiBase,
      );
      chunk.forEach((n, i) => {
        const node = data.repository?.[`p${i}`];
        if (node) result.set(n, node);
      });
    }
    return result;
  });
}

/**
 * Comfortably inside GitHub's per-query node limit (each alias asks for one
 * node), and small enough that the request body stays modest on GHE.
 */
const REPO_CHUNK_SIZE = 80;

export function reposByName<N>(
  operation: string,
  repoFullNames: readonly string[],
  selection: string,
  token: string,
  apiBase: string,
): Effect.Effect<Map<string, N>, GitHubError> {
  return Effect.gen(function* () {
    const result = new Map<string, N>();
    for (let start = 0; start < repoFullNames.length; start += REPO_CHUNK_SIZE) {
      const chunk = repoFullNames.slice(start, start + REPO_CHUNK_SIZE);
      const argDefs: string[] = [];
      const fields: string[] = [];
      const variables: Record<string, string> = {};
      chunk.forEach((fullName, i) => {
        const [owner, name] = fullName.split("/");
        if (!owner || !name) return;
        argDefs.push(`$o${i}: String!, $n${i}: String!`);
        fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ${selection} }`);
        variables[`o${i}`] = owner;
        variables[`n${i}`] = name;
      });
      if (fields.length === 0) continue;

      const data = yield* githubGraphqlPartial<Record<string, N | null>>(
        `query ${operation}(${argDefs.join(", ")}) {\n${fields.join("\n")}\n}`,
        variables,
        token,
        apiBase,
      );
      chunk.forEach((fullName, i) => {
        const node = data[`r${i}`];
        if (node) result.set(fullName, node);
      });
    }
    return result;
  });
}

const PR_DETAIL_FIELDS = `${PR_NODE_FIELDS}
  mergedAt state additions deletions changedFiles`;

interface GqlPrDetail extends GqlOpenPr {
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly mergedAt: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

const PR_DETAIL_CHUNK = 50;

export function getPrsViaGraphql(
  owner: string,
  repo: string,
  repositoryId: string,
  numbers: readonly number[],
  token: string,
  apiBase: string,
): Effect.Effect<Map<number, ObservedPr>, GitHubError> {
  return prsByNumber<GqlPrDetail>(
    "PrDetails",
    owner,
    repo,
    numbers,
    PR_DETAIL_FIELDS,
    PR_DETAIL_CHUNK,
    token,
    apiBase,
  ).pipe(
    Effect.map(
      (nodes) =>
        new Map(
          [...nodes].map(([n, node]): [number, ObservedPr] => [
            n,
            {
              ...mapPrNode(node, repositoryId, STACK_UNSEEN),
              status:
                node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : "open",
              additions: node.additions,
              deletions: node.deletions,
              changedFiles: node.changedFiles,
            },
          ]),
        ),
    ),
  );
}

export interface PrDiffStats {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

const DIFF_STATS_CHUNK = 100;

export function listPrDiffStatsViaGraphql(
  owner: string,
  repo: string,
  numbers: readonly number[],
  token: string,
  apiBase: string,
): Effect.Effect<Map<number, PrDiffStats>, GitHubError> {
  return prsByNumber<PrDiffStats>(
    "PrDiffStats",
    owner,
    repo,
    numbers,
    "additions deletions changedFiles",
    DIFF_STATS_CHUNK,
    token,
    apiBase,
  );
}

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

/**
 * Probe the open-PR list signature of many repos in one request.
 *
 * Cost is the point: GitHub bills a query by the connection pages it could
 * return, so 80 aliased `first: 1` connections are 1 point — where listing
 * those 80 repos is at least 80. Repos GitHub can't resolve are absent from
 * the map; treat absence as "unknown", never as "unchanged".
 */
export function probeOpenPrListSignatures(
  repoFullNames: readonly string[],
  token: string,
  apiBase: string,
): Effect.Effect<Map<string, OpenPrListSignature>, GitHubError> {
  return reposByName<SignatureNode>(
    "OpenPrListSignatures",
    repoFullNames,
    "pullRequests(states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { updatedAt } }",
    token,
    apiBase,
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
  );
}
