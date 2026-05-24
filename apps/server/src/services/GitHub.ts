import type { MergeEligibility, MergeMethod, Org, PullRequest, Repository } from "@revv/shared";
import { Context, Effect, Layer, Schedule } from "effect";
import { serverEnv } from "../config";
import {
  GitHubAuthError,
  type GitHubError,
  GitHubNetworkError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from "../domain/errors";
import type { DbService } from "./Db";
import { buildCacheKey, GitHubEtagCache } from "./GitHubEtagCache";
import { SettingsService } from "./Settings";

/**
 * Resolve the GitHub REST API base URL at call time from user settings.
 * Falls back to `serverEnv.githubHost` when settings haven't been written yet
 * (first-run, or settings file missing). Returns `https://api.github.com` for
 * `github.com`; `https://api.<host>` for GitHub Enterprise.
 */
const resolveApiBase: Effect.Effect<string, never, SettingsService> = Effect.gen(function* () {
  const settings = yield* Effect.flatMap(SettingsService, (s) => s.getSettings()).pipe(
    Effect.orElseSucceed(() => null),
  );
  const host = settings?.githubHost?.trim() || serverEnv.githubHost;
  return host === "github.com" ? "https://api.github.com" : `https://api.${host}`;
});

const retrySchedule = Schedule.intersect(Schedule.exponential("2 seconds"), Schedule.recurs(3));

/** Build the REST API base URL for an explicit host (no settings lookup needed). */
function resolveApiBaseForHost(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://api.${host}`;
}

/** Parse "owner/repo" into parts, failing with GitHubNotFoundError if malformed. */
function parseRepoFullName(
  fullName: string,
): Effect.Effect<{ owner: string; repo: string }, GitHubNotFoundError> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    return Effect.fail(new GitHubNotFoundError({ resource: "repo", id: fullName }));
  }
  return Effect.succeed({ owner, repo });
}

/** Pass through known GitHub errors; wrap unknown ones in GitHubNetworkError. */
function toGitHubError(e: unknown): GitHubError {
  if (
    e instanceof GitHubAuthError ||
    e instanceof GitHubRateLimitError ||
    e instanceof GitHubNotFoundError ||
    e instanceof GitHubNetworkError
  ) {
    return e;
  }
  return new GitHubNetworkError({ cause: e });
}

/** Build the standard headers for GitHub API requests. */
function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Assert a fetch response is successful, throwing the appropriate domain error on failure. */
function assertGitHubOk(res: Response, path: string): void {
  if (res.status === 401) {
    throw new GitHubAuthError({ message: "Invalid or expired GitHub token" });
  }
  if (res.status === 403) {
    const remaining = res.headers.get("X-RateLimit-Remaining");
    if (remaining === "0") {
      const resetHeader = res.headers.get("X-RateLimit-Reset");
      const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : new Date();
      throw new GitHubRateLimitError({ resetAt });
    }
    // Not a rate limit — likely org access restriction or insufficient permissions
    throw new GitHubNetworkError({
      cause: `HTTP 403 – access denied for ${path} (check GitHub org OAuth app policies)`,
    });
  }
  if (res.status === 404) {
    throw new GitHubNotFoundError({ resource: path, id: path });
  }
  if (!res.ok) {
    throw new GitHubNetworkError({ cause: `HTTP ${res.status}` });
  }
}

function githubFetch(
  path: string,
  token: string,
  apiBase: string,
): Effect.Effect<unknown, GitHubError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${apiBase}${path}`, {
        headers: githubHeaders(token),
      });
      assertGitHubOk(res, path);
      return res.json();
    },
    catch: toGitHubError,
  });
}

/**
 * Fetch a single-page GitHub REST endpoint with conditional-request caching.
 *
 * On cache hit with unchanged server state, GitHub responds `304 Not Modified`
 * and we replay the stored body — zero bytes of real payload, zero rate-limit
 * cost. On `200`, we refresh the stored ETag + body for next time.
 *
 * Only use this for endpoints that return a single page. Paginated endpoints
 * (`listUserRepos`, `listReviewComments`) still call `githubFetchPaginated`
 * directly; per-page ETag caching can be added later.
 */
function conditionalFetch(
  path: string,
  token: string,
  apiBase: string,
): Effect.Effect<unknown, GitHubError, DbService | GitHubEtagCache> {
  return Effect.gen(function* () {
    const cache = yield* GitHubEtagCache;
    const cacheKey = buildCacheKey("GET", path);
    const cached = yield* cache.get(cacheKey);

    const result = yield* Effect.tryPromise({
      try: async () => {
        const headers: Record<string, string> = githubHeaders(token);
        if (cached) {
          headers["If-None-Match"] = cached.etag;
        }
        const res = await fetch(`${apiBase}${path}`, { headers });

        if (res.status === 304 && cached) {
          // Server confirms our cached body is still fresh.
          return { kind: "hit" as const, body: cached.body, bytes: 0 };
        }

        // For any other status code, fall through to normal error handling.
        assertGitHubOk(res, path);

        const bodyText = await res.text();
        const body = bodyText ? JSON.parse(bodyText) : null;
        const etag = res.headers.get("ETag");
        const lastModified = res.headers.get("Last-Modified");
        return {
          kind: "miss" as const,
          body,
          bytes: bodyText.length,
          etag,
          lastModified,
        };
      },
      catch: toGitHubError,
    });

    if (result.kind === "hit") {
      // Approximate bytes saved = size of the body we'd have downloaded.
      let saved = 0;
      try {
        saved = JSON.stringify(result.body).length;
      } catch {
        /* swallow — stats are best-effort */
      }
      cache.recordHit(saved);
      return result.body;
    }

    cache.recordMiss();
    if (result.etag) {
      yield* cache.put(cacheKey, result.etag, result.lastModified ?? null, result.body);
    }
    return result.body;
  });
}

function githubPost(
  path: string,
  token: string,
  body: Record<string, unknown>,
  apiBase: string,
): Effect.Effect<unknown, GitHubError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 422) {
        const text = await res.text().catch(() => "");
        throw new GitHubNetworkError({ cause: `422 Unprocessable Entity: ${text}` });
      }
      assertGitHubOk(res, path);
      return res.json();
    },
    catch: toGitHubError,
  });
}

function githubPatch(
  path: string,
  token: string,
  body: Record<string, unknown>,
  apiBase: string,
): Effect.Effect<unknown, GitHubError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${apiBase}${path}`, {
        method: "PATCH",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 422) {
        const text = await res.text().catch(() => "");
        throw new GitHubNetworkError({ cause: `422 Unprocessable Entity: ${text}` });
      }
      assertGitHubOk(res, path);
      return res.json();
    },
    catch: toGitHubError,
  });
}

function githubPut(
  path: string,
  token: string,
  body: Record<string, unknown>,
  apiBase: string,
): Effect.Effect<unknown, GitHubError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${apiBase}${path}`, {
        method: "PUT",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 405) {
        const text = await res.text().catch(() => "");
        throw new GitHubNetworkError({ cause: `HTTP 405 Method Not Allowed: ${text}` });
      }
      if (res.status === 422) {
        const text = await res.text().catch(() => "");
        throw new GitHubNetworkError({ cause: `422 Unprocessable Entity: ${text}` });
      }
      assertGitHubOk(res, path);
      return res.json();
    },
    catch: toGitHubError,
  });
}

/**
 * POST a GraphQL query/mutation. Throws on `errors[]` in the response body
 * even if the HTTP status is 200 (GitHub convention).
 */
function githubGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
  apiBase: string,
): Effect.Effect<T, GitHubError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${apiBase}/graphql`, {
        method: "POST",
        headers: { ...githubHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      assertGitHubOk(res, "/graphql");
      const payload = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (payload.errors && payload.errors.length > 0) {
        throw new GitHubNetworkError({
          cause: `GraphQL: ${payload.errors.map((e) => e.message).join("; ")}`,
        });
      }
      if (!payload.data) {
        throw new GitHubNetworkError({ cause: "GraphQL: empty data field" });
      }
      return payload.data;
    },
    catch: toGitHubError,
  });
}

/** Parse GitHub Link header to find the URL for rel="next". */
function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

/**
 * Fetch a paginated GitHub API list endpoint, following Link rel="next" headers
 * up to `maxPages` pages. Returns the concatenated array of all results.
 */
function githubFetchPaginated(
  path: string,
  token: string,
  maxPages: number = 3,
  apiBase: string,
): Effect.Effect<unknown[], GitHubError> {
  return Effect.tryPromise({
    try: async () => {
      const results: unknown[] = [];
      let url: string | null = `${apiBase}${path}`;

      for (let page = 0; page < maxPages && url; page++) {
        const res = await fetch(url, {
          headers: githubHeaders(token),
        });
        assertGitHubOk(res, path);

        const data = await res.json();
        if (Array.isArray(data)) {
          results.push(...data);
        }

        url = parseLinkNext(res.headers.get("Link"));
      }

      return results;
    },
    catch: toGitHubError,
  });
}

function mapPr(raw: Record<string, unknown>, repositoryId: string): PullRequest {
  const user = raw.user as Record<string, unknown>;
  const head = raw.head as Record<string, unknown>;
  const base = raw.base as Record<string, unknown>;
  const rawReviewers = raw.requested_reviewers as Array<Record<string, unknown>> | undefined;
  const requestedReviewers = (rawReviewers ?? []).map((r) => r.login as string);
  return {
    id: `${repositoryId}:${raw.number}`,
    externalId: raw.number as number,
    repositoryId,
    title: raw.title as string,
    body: (raw.body as string | null) ?? null,
    authorLogin: user.login as string,
    authorAvatarContent: null,
    authorAvatarUrl: (user.avatar_url as string | null) ?? null,
    requestedReviewers,
    status: raw.state === "closed" ? (raw.merged_at ? "merged" : "closed") : "open",
    reviewStatus: "pending",
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
    fetchedAt: new Date().toISOString(),
    closedAt: (raw.closed_at as string | null) ?? null,
  };
}

function mapRepo(raw: Record<string, unknown>): Repository {
  const owner = raw.owner as Record<string, unknown>;
  return {
    id: String(raw.id),
    provider: "github",
    owner: owner.login as string,
    name: raw.name as string,
    fullName: raw.full_name as string,
    defaultBranch: (raw.default_branch as string | undefined) ?? "main",
    avatarUrl: (owner.avatar_url as string | null) ?? null,
    addedAt: new Date().toISOString(),
    cloneStatus: "pending",
    clonePath: null,
    cloneError: null,
    // githubHost is resolved by the caller (repo.githubHost for syncs, current settings host for add-repo)
    githubHost: "",
  };
}

export interface PrMeta {
  readonly baseSha: string;
  readonly headSha: string;
}

export interface PrFileMeta {
  readonly filename: string;
  readonly previousFilename: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}

export interface PrCommit {
  readonly sha: string;
  readonly message: string;
  readonly authorLogin: string | null;
  readonly authorAvatarUrl: string | null;
  readonly date: string | null;
}

export class GitHubService extends Context.Tag("GitHubService")<
  GitHubService,
  {
    readonly listPrs: (
      repoFullName: string,
      repositoryId: string,
      token: string,
      apiBase?: string,
    ) => Effect.Effect<PullRequest[], GitHubError, DbService | GitHubEtagCache | SettingsService>;
    readonly getPr: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<PullRequest, GitHubError, DbService | GitHubEtagCache | SettingsService>;
    /**
     * Find PR numbers closed (or merged) in a time window via GitHub's
     * issue-search API. Used by the recap pipeline to discover PRs that
     * never made it into the local mirror — e.g. closed between two poll
     * cycles or before the user added the repo to Revv.
     *
     * The Search API has a hard cap of 1000 results; for typical
     * daily/weekly windows this is more than enough. Returns the matched
     * PR numbers + their closed/merged metadata; the caller fetches full
     * PR data via `getPr` for any number not already in the local DB.
     */
    readonly searchClosedPrsInWindow: (
      repoFullName: string,
      sinceIso: string,
      untilIso: string,
      token: string,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly number: number;
        readonly closedAt: string;
        readonly merged: boolean;
      }>,
      GitHubError,
      SettingsService
    >;
    readonly getRepo: (
      fullName: string,
      token: string,
    ) => Effect.Effect<Repository, GitHubError, DbService | GitHubEtagCache | SettingsService>;
    /**
     * Like `getRepo`, but bypasses the ETag cache. Required for fields that
     * rotate server-side without changing the endpoint's ETag — notably
     * GitHub Enterprise signed `avatar_url`s, whose token expires but whose
     * ETag stays the same. Hitting `getRepo` would replay the cached body
     * with the now-dead token; this variant forces a 200 every time.
     */
    readonly getRepoFresh: (
      fullName: string,
      token: string,
      apiBase?: string,
    ) => Effect.Effect<Repository, GitHubError, SettingsService>;
    readonly listUserRepos: (
      token: string,
    ) => Effect.Effect<Repository[], GitHubError, SettingsService>;
    /**
     * Open PR count per repo, batched into a single GraphQL request with
     * aliased fields. Repos that error out (missing access, deleted, etc.)
     * are simply omitted from the result map — the caller treats absence as
     * "unknown" and renders accordingly. Pass at most ~80 fullNames per
     * call; longer lists are split internally.
     */
    readonly getOpenPrCounts: (
      fullNames: readonly string[],
      token: string,
    ) => Effect.Effect<Map<string, number>, GitHubError, SettingsService>;
    readonly listUserOrgs: (token: string) => Effect.Effect<Org[], GitHubError, SettingsService>;
    readonly getPrMeta: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<PrMeta, GitHubError, DbService | GitHubEtagCache | SettingsService>;
    readonly getPrFiles: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<PrFileMeta[], GitHubError, DbService | GitHubEtagCache | SettingsService>;
    readonly listPrCommits: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<PrCommit[], GitHubError, SettingsService>;
    readonly getFileContent: (
      repoFullName: string,
      path: string,
      ref: string,
      token: string,
    ) => Effect.Effect<string, GitHubError, SettingsService>;
    /**
     * Fetch the raw bytes for a file at a specific ref. Uses the
     * `application/vnd.github.raw` accept type, which makes GitHub stream
     * the literal blob instead of the base64-encoded JSON envelope —
     * required for binary files (images, fonts) where the local shallow
     * clone may not have the head SHA's blob yet.
     */
    readonly getFileRawBytes: (
      repoFullName: string,
      path: string,
      ref: string,
      token: string,
    ) => Effect.Effect<Uint8Array, GitHubError, SettingsService>;
    readonly postReview: (
      repoFullName: string,
      prNumber: number,
      review: {
        readonly body: string;
        readonly event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
        readonly comments: ReadonlyArray<{
          readonly path: string;
          readonly body: string;
          readonly line: number;
          readonly side: "LEFT" | "RIGHT";
          readonly startLine?: number;
          readonly startSide?: "LEFT" | "RIGHT";
        }>;
      },
      token: string,
    ) => Effect.Effect<{ id: number; htmlUrl: string }, GitHubError, SettingsService>;
    readonly listReviewCommentsForReview: (
      repoFullName: string,
      prNumber: number,
      reviewId: number,
      token: string,
    ) => Effect.Effect<
      Array<{
        id: number;
        path: string;
        line: number | null;
        originalLine: number | null;
        body: string;
      }>,
      GitHubError,
      SettingsService
    >;
    readonly postReviewComment: (
      repoFullName: string,
      prNumber: number,
      comment: {
        readonly path: string;
        readonly body: string;
        readonly line: number;
        readonly side: "LEFT" | "RIGHT";
        readonly startLine?: number;
        readonly startSide?: "LEFT" | "RIGHT";
        readonly commitSha: string;
      },
      token: string,
    ) => Effect.Effect<
      { id: number; htmlUrl: string; createdAt: string },
      GitHubError,
      SettingsService
    >;
    readonly replyToComment: (
      repoFullName: string,
      prNumber: number,
      commentId: string | number,
      body: string,
      token: string,
    ) => Effect.Effect<
      { id: number; htmlUrl: string; createdAt: string },
      GitHubError,
      SettingsService
    >;
    readonly listReviewComments: (
      repoFullName: string,
      prNumber: number,
      since: string | null,
      token: string,
    ) => Effect.Effect<GhReviewComment[], GitHubError, SettingsService>;
    readonly listReviewThreads: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<GhReviewThread[], GitHubError, SettingsService>;
    readonly resolveReviewThread: (
      threadNodeId: string,
      token: string,
    ) => Effect.Effect<void, GitHubError, SettingsService>;
    readonly unresolveReviewThread: (
      threadNodeId: string,
      token: string,
    ) => Effect.Effect<void, GitHubError, SettingsService>;
    readonly getAuthenticatedUser: (
      token: string,
    ) => Effect.Effect<
      { login: string; id: number; avatarUrl: string | null },
      GitHubError,
      DbService | GitHubEtagCache | SettingsService
    >;
    /**
     * Flip an open PR to draft. GitHub only exposes this via GraphQL, which
     * needs the PR's GraphQL node id — we resolve it first via a small
     * lookup query, then run the mutation.
     */
    readonly convertPrToDraft: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<void, GitHubError, SettingsService>;
    /** Inverse of {@link convertPrToDraft}: move a draft back to ready-for-review. */
    readonly markPrReadyForReview: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<void, GitHubError, SettingsService>;
    /**
     * Close (but do not merge) the PR via REST PATCH /pulls/:number with
     * `state: 'closed'`. Closing a draft works the same as closing an open
     * PR.
     */
    readonly closePullRequest: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<void, GitHubError, SettingsService>;
    /**
     * Check whether the authenticated viewer can merge this PR, and whether
     * the PR is actually mergeable (no conflicts, required checks passing, etc.).
     * Uses a lightweight GraphQL query so branch-protection rules are respected.
     */
    readonly getMergeEligibility: (
      repoFullName: string,
      prNumber: number,
      token: string,
    ) => Effect.Effect<MergeEligibility, GitHubError, SettingsService>;
    /**
     * Merge a pull request via the REST API. GitHub returns 405 when the PR
     * is not mergeable (conflicts, failing checks, or not approved); 422 when
     * the merge method is not enabled for the repo.
     */
    readonly mergePullRequest: (
      repoFullName: string,
      prNumber: number,
      mergeMethod: MergeMethod,
      token: string,
    ) => Effect.Effect<void, GitHubError, SettingsService>;
    /**
     * Like `getAuthenticatedUser`, but bypasses the ETag cache. Required for
     * the same reason as {@link getRepoFresh}: GitHub Enterprise signed
     * `avatar_url`s rotate server-side without changing the endpoint's ETag,
     * so a plain `getAuthenticatedUser` would replay the cached body with the
     * now-dead token. This variant forces a 200 every time.
     */
    readonly getAuthenticatedUserFresh: (
      token: string,
    ) => Effect.Effect<
      { login: string; id: number; avatarUrl: string | null },
      GitHubError,
      SettingsService
    >;
    /**
     * Create a new pull request via REST `POST /repos/{owner}/{repo}/pulls`.
     * `head` is the branch name (no `owner:` prefix needed for same-repo
     * PRs). `base` defaults to the repo's default branch — pass it
     * explicitly when the caller wants a different target.
     *
     * Used by the new-PR session flow's Open-PR step (orchestrator-only).
     * The handler is idempotent at the orchestrator layer: callers should
     * first run {@link findPrByHead} and short-circuit if a PR for `head`
     * already exists, since GitHub will reject a duplicate-PR POST with
     * 422.
     */
    readonly createPullRequest: (
      repoFullName: string,
      params: {
        readonly title: string;
        readonly body: string;
        readonly head: string;
        readonly base: string;
        readonly draft?: boolean;
      },
      token: string,
    ) => Effect.Effect<
      {
        readonly id: number;
        readonly nodeId: string;
        readonly number: number;
        readonly htmlUrl: string;
        readonly headSha: string;
        readonly baseSha: string;
      },
      GitHubError,
      SettingsService
    >;
    /**
     * Find an existing PR (open or closed) whose head branch matches
     * `headBranch` in the same repo. Returns null when none exists.
     *
     * The primary use-case is idempotency on the new-PR session
     * Open-PR step: on resume-after-crash, the orchestrator looks up
     * the branch we already pushed and, if a PR was already opened,
     * short-circuits to `complete` without calling `createPullRequest`
     * again.
     */
    readonly findPrByHead: (
      repoFullName: string,
      headBranch: string,
      token: string,
    ) => Effect.Effect<
      {
        readonly number: number;
        readonly nodeId: string;
        readonly htmlUrl: string;
        readonly headSha: string;
        readonly baseSha: string;
      } | null,
      GitHubError,
      SettingsService
    >;
    /**
     * Fetch the collaborator permission level for a specific user on a repo.
     * Uses `GET /repos/{owner}/{repo}/collaborators/{username}/permission`.
     * 404 (user not a collaborator) is mapped to `'none'`.
     *
     * Pass `host` and `token` explicitly so callers can query across GHE
     * hosts without depending on the settings-derived `resolveApiBase`.
     */
    readonly getCollaboratorPermission: (
      token: string,
      host: string,
      owner: string,
      repo: string,
      username: string,
    ) => Effect.Effect<
      "admin" | "maintain" | "write" | "triage" | "read" | "none",
      GitHubError
    >;
  }
>() {}

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

export const GitHubServiceLive = Layer.succeed(GitHubService, {
  listPrs: (repoFullName, repositoryId, token, explicitApiBase) =>
    Effect.gen(function* () {
      const apiBase = explicitApiBase ?? (yield* resolveApiBase);
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const data = yield* githubFetchPaginated(
        `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
        token,
        10,
        apiBase,
      );
      return (data as Record<string, unknown>[]).map((pr) => mapPr(pr, repositoryId));
    }).pipe(Effect.retry(retrySchedule)),

  getPr: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const data = yield* conditionalFetch(
        `/repos/${owner}/${repo}/pulls/${prNumber}`,
        token,
        apiBase,
      );
      return mapPr(data as Record<string, unknown>, `${owner}/${repo}`);
    }).pipe(Effect.retry(retrySchedule)),

  searchClosedPrsInWindow: (repoFullName, sinceIso, untilIso, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      // GitHub's search query syntax: `repo:owner/name is:pr is:closed
      // closed:since..until`. Timestamps in ISO form are accepted with
      // colon/Z encoded. Search has a 1000-result hard cap; we page up
      // to 10 × 100 to reach it. For typical daily/weekly windows that
      // ceiling is far above realistic PR-close volume.
      //
      // Inline pagination — the shared `githubFetchPaginated` helper
      // only handles array-shaped pages, but `/search/issues` wraps
      // results in `{ items, total_count, incomplete_results }`.
      const q = `repo:${owner}/${repo} is:pr is:closed closed:${sinceIso}..${untilIso}`;
      const params = new URLSearchParams({ q, per_page: "100", sort: "updated", order: "desc" });
      const firstPath = `/search/issues?${params.toString()}`;

      const items = yield* Effect.tryPromise({
        try: async () => {
          const collected: Array<{ number: number; closedAt: string; merged: boolean }> = [];
          let url: string | null = `${apiBase}${firstPath}`;
          const MAX_PAGES = 10;
          for (let page = 0; page < MAX_PAGES && url; page++) {
            const res = await fetch(url, { headers: githubHeaders(token) });
            assertGitHubOk(res, firstPath);
            const body = (await res.json()) as { items?: unknown };
            if (Array.isArray(body.items)) {
              for (const raw of body.items) {
                if (raw === null || typeof raw !== "object") continue;
                const item = raw as Record<string, unknown>;
                const number = item.number;
                const closedAt = item.closed_at;
                if (typeof number !== "number" || typeof closedAt !== "string") continue;
                const prMeta = item.pull_request as Record<string, unknown> | null | undefined;
                const merged = typeof prMeta?.merged_at === "string";
                collected.push({ number, closedAt, merged });
              }
            }
            url = parseLinkNext(res.headers.get("Link"));
          }
          return collected;
        },
        catch: toGitHubError,
      });
      return items as ReadonlyArray<{
        readonly number: number;
        readonly closedAt: string;
        readonly merged: boolean;
      }>;
    }).pipe(Effect.retry(retrySchedule)),

  getRepo: (fullName, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(fullName);
      const data = yield* conditionalFetch(`/repos/${owner}/${repo}`, token, apiBase);
      return mapRepo(data as Record<string, unknown>);
    }).pipe(Effect.retry(retrySchedule)),

  getRepoFresh: (fullName, token, explicitApiBase) =>
    Effect.gen(function* () {
      const apiBase = explicitApiBase ?? (yield* resolveApiBase);
      const { owner, repo } = yield* parseRepoFullName(fullName);
      const data = yield* githubFetch(`/repos/${owner}/${repo}`, token, apiBase);
      return mapRepo(data as Record<string, unknown>);
    }).pipe(Effect.retry(retrySchedule)),

  listUserRepos: (token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const data = yield* githubFetchPaginated(
        "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100",
        token,
        3,
        apiBase,
      );
      return (data as Record<string, unknown>[]).map((raw) => mapRepo(raw));
    }).pipe(Effect.retry(retrySchedule)),

  getOpenPrCounts: (fullNames, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const result = new Map<string, number>();
      if (fullNames.length === 0) return result;

      // Batch into chunks to keep GraphQL query complexity and URL length
      // sensible. 80 aliased fields per call sits well under GitHub's
      // 500_000-node complexity budget for `pullRequests(states: OPEN)`.
      const CHUNK_SIZE = 80;
      const chunks: string[][] = [];
      for (let i = 0; i < fullNames.length; i += CHUNK_SIZE) {
        chunks.push(fullNames.slice(i, i + CHUNK_SIZE) as string[]);
      }

      for (const chunk of chunks) {
        // Build aliased fields and a parallel variables block. Owner/name
        // come from listUserRepos (trusted), but variables are still used
        // so the wire payload stays small and GraphQL-cache-friendly.
        const fields: string[] = [];
        const argDefs: string[] = [];
        const variables: Record<string, string> = {};
        chunk.forEach((fn, i) => {
          const slash = fn.indexOf("/");
          if (slash <= 0 || slash === fn.length - 1) return;
          const owner = fn.slice(0, slash);
          const name = fn.slice(slash + 1);
          fields.push(
            `r${i}: repository(owner: $o${i}, name: $n${i}) { pullRequests(states: OPEN) { totalCount } }`,
          );
          argDefs.push(`$o${i}: String!, $n${i}: String!`);
          variables[`o${i}`] = owner;
          variables[`n${i}`] = name;
        });
        if (fields.length === 0) continue;

        const query = `query OpenPrCounts(${argDefs.join(", ")}) {\n${fields.join("\n")}\n}`;

        // GitHub returns partial data on per-field errors (e.g. repo
        // renamed or revoked) — fetch directly so we can tolerate the
        // partial-success case the shared `githubGraphql` helper rejects.
        const response = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${apiBase}/graphql`, {
              method: "POST",
              headers: { ...githubHeaders(token), "Content-Type": "application/json" },
              body: JSON.stringify({ query, variables }),
            });
            assertGitHubOk(res, "/graphql");
            return (await res.json()) as {
              data?: Record<string, { pullRequests: { totalCount: number } } | null>;
            };
          },
          catch: toGitHubError,
        });

        const data = response.data ?? {};
        chunk.forEach((fn, i) => {
          const node = data[`r${i}`];
          if (node) result.set(fn, node.pullRequests.totalCount);
        });
      }

      return result;
    }).pipe(Effect.retry(retrySchedule)),

  listUserOrgs: (token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const data = yield* githubFetchPaginated("/user/orgs?per_page=100", token, 3, apiBase);
      return (data as Record<string, unknown>[]).map((raw) => ({
        login: raw.login as string,
        avatarUrl: (raw.avatar_url as string | null) ?? null,
      }));
    }).pipe(Effect.retry(retrySchedule)),

  getPrMeta: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const data = yield* conditionalFetch(
        `/repos/${owner}/${repo}/pulls/${prNumber}`,
        token,
        apiBase,
      );
      const raw = data as Record<string, unknown>;
      const base = raw.base as Record<string, unknown>;
      const head = raw.head as Record<string, unknown>;
      return { baseSha: base.sha as string, headSha: head.sha as string };
    }).pipe(Effect.retry(retrySchedule)),

  getPrFiles: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const data = yield* conditionalFetch(
        `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
        token,
        apiBase,
      );
      return (data as Record<string, unknown>[]).map((f) => ({
        filename: f.filename as string,
        previousFilename: (f.previous_filename as string | undefined) ?? null,
        status: f.status as string,
        additions: (f.additions as number | undefined) ?? 0,
        deletions: (f.deletions as number | undefined) ?? 0,
        patch: (f.patch as string | undefined) ?? null,
      }));
    }).pipe(Effect.retry(retrySchedule)),

  listPrCommits: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      // Paginate to capture the head commit. GitHub's PR commits endpoint
      // returns up to 250 commits in ascending date order (oldest first),
      // so a non-paginated `per_page=20` call on a long-running PR drops
      // the actual HEAD off the end of page 1 — which is what caused the
      // dropdown to omit the latest commit. 3 × 100 = 300 covers the cap.
      const data = yield* githubFetchPaginated(
        `/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`,
        token,
        3,
        apiBase,
      );
      // Extract parent SHAs so we can topologically sort. GitHub's docs
      // claim this endpoint returns commits "in the order they appear on
      // the branch," but that order is not stable across force-pushes,
      // cherry-picks, and unusual merge histories — the root cause of
      // reports where the dropdown shows commits in an unexpected order.
      // Walking the first-parent chain from head is deterministic.
      type RawCommit = PrCommit & { readonly parents: readonly string[] };
      const raw: RawCommit[] = (data as Record<string, unknown>[]).map((c) => {
        const commit = c.commit as Record<string, unknown>;
        const author = c.author as Record<string, unknown> | null;
        const commitAuthor = commit.author as Record<string, unknown> | null;
        const parentsRaw = (c.parents as Record<string, unknown>[] | undefined) ?? [];
        const parents = parentsRaw.map((p) => p.sha as string);
        const message = commit.message as string;
        return {
          sha: c.sha as string,
          message: message.split("\n")[0] ?? message,
          authorLogin: author ? (author.login as string) : null,
          authorAvatarUrl: author ? ((author.avatar_url as string | null) ?? null) : null,
          date: commitAuthor ? ((commitAuthor.date as string | null) ?? null) : null,
          parents,
        };
      });

      // Topological sort: walk first-parent chain from head → oldest.
      // `head` is the one commit in the list that isn't a parent of any
      // other commit in the list (base commits outside the PR aren't in
      // `inRange`, so the first PR commit's out-of-range parent is
      // correctly ignored).
      const byHash = new Map(raw.map((c) => [c.sha, c]));
      const inRange = new Set(raw.map((c) => c.sha));
      const isParentInRange = new Set<string>();
      for (const c of raw) {
        for (const p of c.parents) {
          if (inRange.has(p)) isParentInRange.add(p);
        }
      }
      const head = raw.find((c) => !isParentInRange.has(c.sha));
      const ordered: RawCommit[] = [];
      const visited = new Set<string>();
      let current: RawCommit | undefined = head;
      while (current && !visited.has(current.sha)) {
        visited.add(current.sha);
        ordered.push(current);
        const firstParent = current.parents[0];
        current = firstParent ? byHash.get(firstParent) : undefined;
      }
      // Append anything unreached (rare: disconnected merge histories).
      // Keeps those commits visible rather than silently dropping them.
      for (const c of raw) {
        if (!visited.has(c.sha)) ordered.push(c);
      }

      return ordered.map(
        (c): PrCommit => ({
          sha: c.sha,
          message: c.message,
          authorLogin: c.authorLogin,
          authorAvatarUrl: c.authorAvatarUrl,
          date: c.date,
        }),
      );
    }).pipe(Effect.retry(retrySchedule)),

  getFileContent: (repoFullName, path, ref, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const data = yield* githubFetch(
        `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`,
        token,
        apiBase,
      );
      const obj = data as Record<string, unknown>;
      if (obj.encoding === "base64" && typeof obj.content === "string") {
        return Buffer.from(obj.content as string, "base64").toString("utf-8");
      }
      // Binary or unsupported encoding
      return "";
    }).pipe(Effect.retry(retrySchedule)),

  getFileRawBytes: (repoFullName, path, ref, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const url = `${apiBase}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`;
      return yield* Effect.tryPromise({
        try: async () => {
          // `application/vnd.github.raw` flips the response from a base64
          // JSON envelope to the literal blob. The other GitHub headers
          // (Auth, API version) stay the same.
          const res = await fetch(url, {
            headers: {
              ...githubHeaders(token),
              Accept: "application/vnd.github.raw",
            },
          });
          assertGitHubOk(res, `/repos/${owner}/${repo}/contents/${encodedPath}`);
          const buf = await res.arrayBuffer();
          return new Uint8Array(buf);
        },
        catch: toGitHubError,
      });
    }).pipe(Effect.retry(retrySchedule)),

  postReview: (repoFullName, prNumber, review, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const payload: Record<string, unknown> = {
        event: review.event,
        body: review.body,
      };
      if (review.comments.length > 0) {
        payload.comments = review.comments.map((c) => {
          const comment: Record<string, unknown> = {
            path: c.path,
            body: c.body,
            line: c.line,
            side: c.side,
          };
          if (c.startLine !== undefined && c.startLine !== c.line) {
            comment.start_line = c.startLine;
            comment.start_side = c.startSide ?? c.side;
          }
          return comment;
        });
      }
      const data = yield* githubPost(
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        token,
        payload,
        apiBase,
      );
      const raw = data as Record<string, unknown>;
      return {
        id: raw.id as number,
        htmlUrl: (raw.html_url as string | undefined) ?? "",
      };
    }),

  listReviewCommentsForReview: (repoFullName, prNumber, reviewId, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const data = yield* githubFetch(
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
        token,
        apiBase,
      );
      const raw = data as Array<Record<string, unknown>>;
      return raw.map((c) => ({
        id: c.id as number,
        path: c.path as string,
        line: (c.line as number | null | undefined) ?? null,
        originalLine: (c.original_line as number | null | undefined) ?? null,
        body: c.body as string,
      }));
    }),

  postReviewComment: (repoFullName, prNumber, c, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const payload: Record<string, unknown> = {
        body: c.body,
        commit_id: c.commitSha,
        path: c.path,
        line: c.line,
        side: c.side,
      };
      if (c.startLine !== undefined && c.startLine !== c.line) {
        payload.start_line = c.startLine;
        payload.start_side = c.startSide ?? c.side;
      }
      const data = yield* githubPost(
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        token,
        payload,
        apiBase,
      );
      const raw = data as Record<string, unknown>;
      return {
        id: raw.id as number,
        htmlUrl: (raw.html_url as string | undefined) ?? "",
        createdAt: (raw.created_at as string | undefined) ?? new Date().toISOString(),
      };
    }),

  replyToComment: (repoFullName, prNumber, commentId, body, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const data = yield* githubPost(
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
        token,
        { body },
        apiBase,
      );
      const raw = data as Record<string, unknown>;
      return {
        id: raw.id as number,
        htmlUrl: (raw.html_url as string | undefined) ?? "",
        createdAt: (raw.created_at as string | undefined) ?? new Date().toISOString(),
      };
    }),

  listReviewComments: (repoFullName, prNumber, since, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const sinceQ = since ? `&since=${encodeURIComponent(since)}` : "";
      const data = yield* githubFetchPaginated(
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100${sinceQ}`,
        token,
        5,
        apiBase,
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
    }).pipe(Effect.retry(retrySchedule)),

  listReviewThreads: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      // GraphQL paginates at 100 per page — most PRs fit, but we page just in case.
      const query = `
				query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
					repository(owner: $owner, name: $repo) {
						pullRequest(number: $number) {
							reviewThreads(first: 100, after: $cursor) {
								pageInfo { hasNextPage endCursor }
								nodes {
									id
									isResolved
									comments(first: 100) {
										nodes { databaseId }
									}
								}
							}
						}
					}
				}
			`;
      interface ReviewThreadsResp {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{
                id: string;
                isResolved: boolean;
                comments: { nodes: Array<{ databaseId: number }> };
              }>;
            };
          };
        };
      }
      const out: GhReviewThread[] = [];
      let cursor: string | null = null;
      for (let p = 0; p < 5; p++) {
        const data: ReviewThreadsResp = yield* githubGraphql<ReviewThreadsResp>(
          query,
          { owner, repo, number: prNumber, cursor },
          token,
          apiBase,
        );
        const page = data.repository.pullRequest.reviewThreads;
        for (const node of page.nodes) {
          out.push({
            nodeId: node.id,
            isResolved: node.isResolved,
            commentDatabaseIds: node.comments.nodes.map(
              (n: { databaseId: number }) => n.databaseId,
            ),
          });
        }
        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
      }
      return out;
    }).pipe(Effect.retry(retrySchedule)),

  resolveReviewThread: (threadNodeId, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      yield* githubGraphql(
        `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }`,
        { id: threadNodeId },
        token,
        apiBase,
      );
    }),

  unresolveReviewThread: (threadNodeId, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      yield* githubGraphql(
        `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { clientMutationId } }`,
        { id: threadNodeId },
        token,
        apiBase,
      );
    }),

  getAuthenticatedUser: (token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const data = yield* conditionalFetch(`/user`, token, apiBase);
      const raw = data as Record<string, unknown>;
      return {
        login: raw.login as string,
        id: raw.id as number,
        avatarUrl: (raw.avatar_url as string | null) ?? null,
      };
    }).pipe(Effect.retry(retrySchedule)),

  getAuthenticatedUserFresh: (token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const data = yield* githubFetch(`/user`, token, apiBase);
      const raw = data as Record<string, unknown>;
      return {
        login: raw.login as string,
        id: raw.id as number,
        avatarUrl: (raw.avatar_url as string | null) ?? null,
      };
    }).pipe(Effect.retry(retrySchedule)),

  convertPrToDraft: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const nodeId = yield* resolvePrNodeId(owner, repo, prNumber, token, apiBase);
      yield* githubGraphql(
        `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id: nodeId },
        token,
        apiBase,
      );
    }),

  markPrReadyForReview: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const nodeId = yield* resolvePrNodeId(owner, repo, prNumber, token, apiBase);
      yield* githubGraphql(
        `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id: nodeId },
        token,
        apiBase,
      );
    }),

  closePullRequest: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      yield* githubPatch(
        `/repos/${owner}/${repo}/pulls/${prNumber}`,
        token,
        { state: "closed" },
        apiBase,
      );
    }),

  getMergeEligibility: (repoFullName, prNumber, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const query = `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              mergeable
              mergeStateStatus
            }
            viewerPermission
          }
        }
      `;
      interface Resp {
        repository: {
          pullRequest: {
            mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
            mergeStateStatus: string | null;
          } | null;
          viewerPermission: "ADMIN" | "MAINTAIN" | "WRITE" | "READ" | "NONE" | null;
        } | null;
      }
      const data = yield* githubGraphql<Resp>(
        query,
        { owner, repo, number: prNumber },
        token,
        apiBase,
      );
      const pr = data.repository?.pullRequest;
      if (!pr) {
        return yield* Effect.fail(
          new GitHubNotFoundError({
            resource: "pull_request",
            id: `${owner}/${repo}#${prNumber}`,
          }),
        );
      }
      const perm = data.repository?.viewerPermission;
      const canMerge = perm === "ADMIN" || perm === "MAINTAIN" || perm === "WRITE";
      return {
        canMerge,
        mergeable: pr.mergeable === "MERGEABLE",
        mergeStateStatus: pr.mergeStateStatus ?? "unknown",
      };
    }),

  mergePullRequest: (repoFullName, prNumber, mergeMethod, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      yield* githubPut(
        `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
        token,
        { merge_method: mergeMethod },
        apiBase,
      );
    }),

  createPullRequest: (repoFullName, params, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      const body: Record<string, unknown> = {
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      };
      if (params.draft !== undefined) body.draft = params.draft;
      const data = yield* githubPost(`/repos/${owner}/${repo}/pulls`, token, body, apiBase);
      const raw = data as Record<string, unknown>;
      const head = (raw.head as Record<string, unknown> | undefined) ?? {};
      const base = (raw.base as Record<string, unknown> | undefined) ?? {};
      return {
        id: raw.id as number,
        nodeId: (raw.node_id as string | undefined) ?? "",
        number: raw.number as number,
        htmlUrl: (raw.html_url as string | undefined) ?? "",
        headSha: (head.sha as string | undefined) ?? "",
        baseSha: (base.sha as string | undefined) ?? "",
      };
    }),

  findPrByHead: (repoFullName, headBranch, token) =>
    Effect.gen(function* () {
      const apiBase = yield* resolveApiBase;
      const { owner, repo } = yield* parseRepoFullName(repoFullName);
      // GitHub expects head as `owner:branch` to disambiguate forks.
      const headQuery = encodeURIComponent(`${owner}:${headBranch}`);
      const data = yield* githubFetch(
        `/repos/${owner}/${repo}/pulls?state=all&head=${headQuery}&per_page=1`,
        token,
        apiBase,
      );
      const list = data as Array<Record<string, unknown>>;
      const first = list[0];
      if (!first) return null;
      const head = (first.head as Record<string, unknown> | undefined) ?? {};
      const base = (first.base as Record<string, unknown> | undefined) ?? {};
      return {
        number: first.number as number,
        nodeId: (first.node_id as string | undefined) ?? "",
        htmlUrl: (first.html_url as string | undefined) ?? "",
        headSha: (head.sha as string | undefined) ?? "",
        baseSha: (base.sha as string | undefined) ?? "",
      };
    }),

  getCollaboratorPermission: (token, host, owner, repo, username) =>
    Effect.tryPromise({
      try: async () => {
        const apiBase = resolveApiBaseForHost(host);
        const res = await fetch(
          `${apiBase}/repos/${owner}/${repo}/collaborators/${username}/permission`,
          { headers: githubHeaders(token) },
        );
        if (res.status === 404) return "none" as const;
        if (res.status === 401) throw new GitHubAuthError({ message: "Invalid or expired token" });
        if (res.status === 403) throw new GitHubNetworkError({ cause: `HTTP 403 on ${owner}/${repo}` });
        if (!res.ok) throw new GitHubNetworkError({ cause: `HTTP ${res.status}` });
        const body = (await res.json()) as { role_name?: string };
        const roleName = body.role_name ?? "none";
        if (
          roleName === "admin" ||
          roleName === "maintain" ||
          roleName === "write" ||
          roleName === "triage" ||
          roleName === "read" ||
          roleName === "none"
        ) {
          return roleName;
        }
        return "none" as const;
      },
      catch: toGitHubError,
    }),
});

/**
 * Look up a PR's GraphQL node id. Required by the draft-toggle mutations
 * (`convertPullRequestToDraft`, `markPullRequestReadyForReview`), which only
 * accept the global node id — not owner/repo/number. Cheaper than a full PR
 * fetch and bypasses the conditional cache so we always get a fresh id.
 */
function resolvePrNodeId(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  apiBase: string,
): Effect.Effect<string, GitHubError> {
  const query = `
		query($owner: String!, $repo: String!, $number: Int!) {
			repository(owner: $owner, name: $repo) {
				pullRequest(number: $number) { id }
			}
		}
	`;
  interface Resp {
    repository: { pullRequest: { id: string } | null } | null;
  }
  return Effect.gen(function* () {
    const data = yield* githubGraphql<Resp>(
      query,
      { owner, repo, number: prNumber },
      token,
      apiBase,
    );
    const id = data.repository?.pullRequest?.id;
    if (!id) {
      return yield* Effect.fail(
        new GitHubNotFoundError({ resource: "pull_request", id: `${owner}/${repo}#${prNumber}` }),
      );
    }
    return id;
  });
}
