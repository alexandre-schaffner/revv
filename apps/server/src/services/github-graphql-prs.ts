/**
 * The open-PR list over GraphQL, and the one-request probe that says whether
 * re-reading it could find anything new.
 *
 * Split out of `GitHub.ts`, which exposes both through `GitHubGateway.prs`.
 */
import type { PullRequest } from "@revv/shared";
import { Effect } from "effect";
import { type GitHubError, GitHubNotFoundError } from "../domain/errors";
import { githubGraphqlPartial, paginateGraphql } from "./github-rest";

/**
 * A few active repos exceed 1,000 open PRs. Bounded for rate-limit safety, but
 * well past the point where a team filter would need rows GitHub's first pages
 * didn't return.
 */
const OPEN_PRS_MAX_PAGES = 50;

// Exactly the fields `mapPrNode` reads. `additions`/`deletions`/`changedFiles`
// are left out on purpose: GitHub computes them per PR, which made this query
// ~20% slower, and `listPrDiffStats` already fetches them for the PRs that
// actually need them.
const OPEN_PRS_QUERY = `query OpenPullRequests($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
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
        }
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

/** Map an `OPEN_PRS_QUERY` node to the same row `mapPr` builds from REST. */
function mapPrNode(node: GqlOpenPr, repositoryId: string): PullRequest {
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
  };
}

/** Every open PR of `owner/repo`, most recently updated first. */
export function listOpenPrsViaGraphql(
  owner: string,
  repo: string,
  repositoryId: string,
  token: string,
  apiBase: string,
): Effect.Effect<PullRequest[], GitHubError> {
  return paginateGraphql<OpenPrsResp, GqlOpenPr>({
    query: OPEN_PRS_QUERY,
    variables: { owner, name: repo },
    selectConnection: (data) => data.repository?.pullRequests,
    maxPages: OPEN_PRS_MAX_PAGES,
    token,
    apiBase,
    notFound: () => new GitHubNotFoundError({ resource: "repo", id: `${owner}/${repo}` }),
  }).pipe(Effect.map((nodes) => nodes.map((node) => mapPrNode(node, repositoryId))));
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

/**
 * Comfortably inside GitHub's per-query node limit (each alias asks for one
 * node), and small enough that the request body stays modest on GHE.
 */
const SIGNATURE_CHUNK_SIZE = 80;

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
  return Effect.gen(function* () {
    const result = new Map<string, OpenPrListSignature>();
    for (let start = 0; start < repoFullNames.length; start += SIGNATURE_CHUNK_SIZE) {
      const chunk = repoFullNames.slice(start, start + SIGNATURE_CHUNK_SIZE);
      const argDefs: string[] = [];
      const fields: string[] = [];
      const variables: Record<string, string> = {};
      chunk.forEach((fullName, i) => {
        const [owner, name] = fullName.split("/");
        if (!owner || !name) return;
        argDefs.push(`$o${i}: String!, $n${i}: String!`);
        fields.push(
          `r${i}: repository(owner: $o${i}, name: $n${i}) { pullRequests(states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { updatedAt } } }`,
        );
        variables[`o${i}`] = owner;
        variables[`n${i}`] = name;
      });
      if (fields.length === 0) continue;

      const data = yield* githubGraphqlPartial<Record<string, SignatureNode | null>>(
        `query OpenPrListSignatures(${argDefs.join(", ")}) {\n${fields.join("\n")}\n}`,
        variables,
        token,
        apiBase,
      );
      chunk.forEach((fullName, i) => {
        const node = data[`r${i}`];
        if (!node) return;
        result.set(fullName, {
          count: node.pullRequests.totalCount,
          latestUpdatedAt: node.pullRequests.nodes[0]?.updatedAt ?? null,
        });
      });
    }
    return result;
  });
}
