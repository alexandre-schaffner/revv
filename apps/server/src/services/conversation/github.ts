// ── GitHub: PR conversation ─────────────────────────────────────────────────
//
// The GitHub calls behind the Conversation tab: one GraphQL query for the
// page, a rollup-only query for polling pending checks, REST for check
// details and Actions logs, and the pickers' search queries. Plain functions
// of `(token, apiBase)`; the writes live in `writes.ts`.

import type {
  ActorOption,
  CheckAnnotation,
  CheckDetails,
  CiAccess,
  CiRollup,
  CodeownersFile,
  TeamOption,
} from "@revv/shared";
import { CODEOWNERS_PATHS, parseCodeowners } from "@revv/shared";
import { Effect } from "effect";
import {
  GitHubAccessDeniedError,
  GitHubApiError,
  type GitHubError,
  GitHubNotFoundError,
} from "../../domain/errors";
import {
  conditionalFetchPaginated,
  githubFetch,
  githubFetchRedirectText,
  githubGraphql,
  githubGraphqlWithErrors,
  retryTransient,
  withSchemaFallback,
} from "../github-rest";
import { extractLogTail } from "./log-tail";
import {
  collectAvatarUrls,
  type MappedConversation,
  mapConversation,
  mapRollup,
  nodesOf,
  type RawCheckRollup,
  type RawConnection,
  type RawConversation,
  type RawLabel,
  type RawPage,
  type RawRollupCommits,
  type RawTimelineNode,
  toLabel,
} from "./map";
import {
  CODEOWNERS_QUERY,
  checkContextsPageQuery,
  checksQuery,
  conversationQuery,
  MODERN_TOKENS,
  TIMELINE_MAX_PAGES,
  timelinePageQuery,
} from "./queries";

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

// ── Fetching ────────────────────────────────────────────────────────────────

/**
 * One GraphQL ask that survives fields the token may not read. A GitHub App
 * installation answers a field outside its permissions with `null` plus a
 * `FORBIDDEN` error (`statusCheckRollup` without `checks: read`), and that
 * must cost the page that field, not the whole answer. Returns the paths
 * that came back forbidden; any other error still fails the ask, so schema
 * complaints keep reaching {@link askWithFallback}.
 */
function askGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
  apiBase: string,
): Effect.Effect<{ data: T; forbidden: string[] }, GitHubError> {
  return Effect.flatMap(
    githubGraphqlWithErrors<T>(query, variables, token, apiBase),
    ({ data, errors }) => {
      const forbidden: string[] = [];
      const fatal: string[] = [];
      for (const error of errors) {
        const path = error.path?.join(".") ?? "";
        // Deeper than `repository.pullRequest` is a field the page can lose;
        // the repository or PR itself being forbidden is no answer at all.
        if (error.type === "FORBIDDEN" && path.split(".").length > 2) forbidden.push(path);
        else fatal.push(error.message);
      }
      if (fatal.length === 0) return Effect.succeed({ data, forbidden });
      const denied = errors.some((e) => e.type === "FORBIDDEN");
      return Effect.fail(
        denied
          ? new GitHubAccessDeniedError({ resource: "pull_request", message: fatal.join("; ") })
          : new GitHubApiError({ status: 200, cause: `GraphQL: ${fatal.join("; ")}` }),
      );
    },
  );
}

/** The head commit's checks came back forbidden: the token can't read CI. */
function ciAccessOf(forbidden: readonly string[]): CiAccess {
  return forbidden.some((p) => p.startsWith("repository.pullRequest.commits."))
    ? "denied"
    : "granted";
}

/**
 * Ask the modern query; on a schema complaint naming a field an older GitHub
 * Enterprise lacks, ask the legacy one. Returns which one answered so the
 * follow-up timeline pages use the same shape.
 */
function askWithFallback<T>(
  build: (modern: boolean) => string,
  variables: Record<string, unknown>,
  token: string,
  apiBase: string,
): Effect.Effect<{ data: T; forbidden: string[]; modern: boolean }, GitHubError> {
  return withSchemaFallback(
    (modern) => askGraphql<T>(build(modern), variables, token, apiBase),
    MODERN_TOKENS,
  ).pipe(Effect.map(({ value, modern }) => ({ ...value, modern })));
}

export interface FetchedConversation {
  readonly conversation: MappedConversation;
  readonly avatarUrls: Map<string, string>;
}

/** Read every CI context before mapping it; an omitted check may block the PR. */
function completeCheckContexts(
  ref: RepoRef,
  number: number,
  commits: RawRollupCommits,
  modern: boolean,
  token: string,
  apiBase: string,
): Effect.Effect<RawRollupCommits, GitHubError> {
  return Effect.gen(function* () {
    const head = nodesOf(commits)[0]?.commit;
    const rollup = head?.statusCheckRollup;
    if (!head || !rollup) return commits;
    const contexts = nodesOf(rollup.contexts);
    let pageInfo = rollup.contexts.pageInfo;
    while (pageInfo?.hasNextPage) {
      const { data } = yield* askGraphql<{
        repository: { object: { statusCheckRollup: RawCheckRollup | null } | null } | null;
      }>(
        checkContextsPageQuery(modern),
        {
          owner: ref.owner,
          repo: ref.repo,
          number,
          sha: head.oid,
          checkCursor: pageInfo.endCursor,
        },
        token,
        apiBase,
      );
      const page = data.repository?.object?.statusCheckRollup?.contexts;
      if (!page || (page.pageInfo?.hasNextPage && page.pageInfo.endCursor === pageInfo.endCursor)) {
        return yield* Effect.fail(
          new GitHubApiError({ status: 200, cause: "GitHub returned an incomplete CI page" }),
        );
      }
      contexts.push(...nodesOf(page));
      pageInfo = page.pageInfo;
    }
    return {
      nodes: [
        { commit: { ...head, statusCheckRollup: { ...rollup, contexts: { nodes: contexts } } } },
      ],
    };
  });
}

export function fetchConversation(
  ref: RepoRef,
  number: number,
  prId: string,
  token: string,
  apiBase: string,
): Effect.Effect<FetchedConversation, GitHubError> {
  return Effect.gen(function* () {
    const variables = { owner: ref.owner, repo: ref.repo, number };
    const { data, forbidden, modern } = yield* askWithFallback<RawConversation>(
      conversationQuery,
      variables,
      token,
      apiBase,
    );
    const pr = data.repository?.pullRequest;
    if (!pr) {
      return yield* Effect.fail(
        new GitHubNotFoundError({
          resource: "pull_request",
          id: `${ref.owner}/${ref.repo}#${number}`,
        }),
      );
    }

    // The query read the newest page; walk back through older ones, up to
    // the cap. Each page is oldest-first, so it goes in front of the last.
    const olderPages: RawTimelineNode[][] = [];
    let pageInfo = pr.timelineItems?.pageInfo ?? { hasPreviousPage: false, startCursor: null };
    let pages = 1;
    while (pageInfo.hasPreviousPage && pages < TIMELINE_MAX_PAGES) {
      const next = yield* askGraphql<{
        repository: { pullRequest: { timelineItems: RawPage<RawTimelineNode> } | null } | null;
      }>(timelinePageQuery(modern), { ...variables, cursor: pageInfo.startCursor }, token, apiBase);
      const page = next.data.repository?.pullRequest?.timelineItems;
      if (!page) break;
      olderPages.unshift(nodesOf(page));
      pageInfo = page.pageInfo;
      pages++;
    }
    const older = olderPages.flat();

    const commits = yield* completeCheckContexts(ref, number, pr.commits, modern, token, apiBase);
    const conversation = mapConversation(
      { ...data, repository: { ...data.repository, pullRequest: { ...pr, commits } } },
      older,
      prId,
      pageInfo.hasPreviousPage,
      new Date().toISOString(),
      ciAccessOf(forbidden),
    );
    if (!conversation) {
      return yield* Effect.fail(
        new GitHubNotFoundError({
          resource: "pull_request",
          id: `${ref.owner}/${ref.repo}#${number}`,
        }),
      );
    }
    return { conversation, avatarUrls: collectAvatarUrls(data, older) };
  }).pipe(retryTransient);
}

export function fetchCiRollup(
  ref: RepoRef,
  number: number,
  token: string,
  apiBase: string,
): Effect.Effect<{ rollup: CiRollup | null; access: CiAccess }, GitHubError> {
  return askWithFallback<{
    repository: { pullRequest: { commits: RawRollupCommits } | null } | null;
  }>(checksQuery, { owner: ref.owner, repo: ref.repo, number }, token, apiBase).pipe(
    Effect.flatMap(({ data, forbidden, modern }) =>
      Effect.gen(function* () {
        const access = ciAccessOf(forbidden);
        const commits = data.repository?.pullRequest?.commits;
        return {
          rollup:
            access === "denied" || !commits
              ? null
              : mapRollup(
                  yield* completeCheckContexts(ref, number, commits, modern, token, apiBase),
                ),
          access,
        };
      }),
    ),
    retryTransient,
  );
}

/**
 * The CODEOWNERS file GitHub would apply to a PR into `baseRef`: the first
 * of its three locations that exists on that branch. Null when there is none,
 * or the token can't read repository contents (a missing grant must not cost
 * the page).
 */
export function fetchCodeowners(
  ref: RepoRef,
  baseRef: string,
  token: string,
  apiBase: string,
): Effect.Effect<CodeownersFile | null, GitHubError> {
  type Blob = { readonly text: string | null } | null;
  return githubGraphqlWithErrors<{
    repository: { a: Blob; b: Blob; c: Blob } | null;
  }>(
    CODEOWNERS_QUERY,
    {
      owner: ref.owner,
      repo: ref.repo,
      a: `${baseRef}:${CODEOWNERS_PATHS[0]}`,
      b: `${baseRef}:${CODEOWNERS_PATHS[1]}`,
      c: `${baseRef}:${CODEOWNERS_PATHS[2]}`,
    },
    token,
    apiBase,
  ).pipe(
    Effect.map(({ data }) => {
      const blobs = [data.repository?.a, data.repository?.b, data.repository?.c];
      const index = blobs.findIndex((blob) => typeof blob?.text === "string");
      const text = blobs[index]?.text;
      const path = CODEOWNERS_PATHS[index];
      return typeof text === "string" && path
        ? { path, ref: baseRef, rules: parseCodeowners(text) }
        : null;
    }),
    Effect.catchIf(
      (e) => e instanceof GitHubApiError || e instanceof GitHubAccessDeniedError,
      () => Effect.succeed(null),
    ),
  );
}

interface RawCheckRun {
  readonly status: string;
  readonly output?: { readonly title: string | null; readonly summary: string | null } | null;
  readonly app?: { readonly slug: string } | null;
}

interface RawAnnotation {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly annotation_level: string;
  readonly title: string | null;
  readonly message: string;
}

function toAnnotation(raw: RawAnnotation): CheckAnnotation {
  const level =
    raw.annotation_level === "failure" || raw.annotation_level === "warning"
      ? raw.annotation_level
      : "notice";
  return {
    path: raw.path,
    startLine: raw.start_line,
    endLine: raw.end_line,
    level,
    title: raw.title?.trim() || null,
    message: raw.message,
  };
}

/**
 * A check run's output, annotations, and (for GitHub Actions jobs) the
 * failing step's log. A log that can't be read degrades to a reason, never
 * to an error: the token may lack `actions: read` (GitHub App installs), or
 * the logs may have expired.
 */
export function fetchCheckDetails(
  ref: RepoRef,
  checkRunId: number,
  token: string,
  apiBase: string,
): Effect.Effect<CheckDetails, GitHubError> {
  return Effect.gen(function* () {
    const base = `/repos/${ref.owner}/${ref.repo}`;
    const run = (yield* githubFetch(
      `${base}/check-runs/${checkRunId}`,
      token,
      apiBase,
    )) as RawCheckRun;
    const annotations = (yield* githubFetch(
      `${base}/check-runs/${checkRunId}/annotations?per_page=50`,
      token,
      apiBase,
    ).pipe(Effect.orElseSucceed(() => []))) as RawAnnotation[];

    let log: CheckDetails["log"] = null;
    let logUnavailable: CheckDetails["logUnavailable"] = null;
    if (run.app?.slug !== "github-actions") {
      logUnavailable = "not_actions";
    } else if (run.status !== "completed") {
      logUnavailable = "running";
    } else {
      // For Actions, the check-run id is the job id.
      const text = yield* githubFetchRedirectText(
        `${base}/actions/jobs/${checkRunId}/logs`,
        token,
        apiBase,
      ).pipe(Effect.either);
      if (text._tag === "Right") {
        log = extractLogTail(text.right);
      } else {
        logUnavailable =
          text.left instanceof GitHubAccessDeniedError
            ? "permission"
            : text.left instanceof GitHubNotFoundError ||
                (text.left instanceof GitHubApiError && text.left.status === 410)
              ? "expired"
              : yield* Effect.fail(text.left);
      }
    }

    return {
      checkRunId,
      completed: run.status === "completed",
      title: run.output?.title?.trim() || null,
      summary: run.output?.summary?.trim() || null,
      annotations: annotations.map(toAnnotation),
      log,
      logUnavailable,
    };
  }).pipe(retryTransient);
}

// ── Picker sources ──────────────────────────────────────────────────────────

export function listRepoLabels(ref: RepoRef, token: string, apiBase: string) {
  return conditionalFetchPaginated(
    `/repos/${ref.owner}/${ref.repo}/labels?per_page=100`,
    token,
    5,
    apiBase,
    { canReplayCached: () => true },
  ).pipe(
    Effect.map((rows) =>
      (rows as RawLabel[]).map(toLabel).sort((a, b) => a.name.localeCompare(b.name)),
    ),
  );
}

/**
 * Users who can be assigned to (and asked to review) the PR, filtered by a
 * search string. GitHub's `assignableUsers(query:)` matches login and name.
 */
export function searchAssignableUsers(
  ref: RepoRef,
  query: string,
  token: string,
  apiBase: string,
): Effect.Effect<Array<ActorOption & { readonly avatarUrl: string | null }>, GitHubError> {
  return githubGraphql<{
    repository: {
      assignableUsers: RawConnection<{ login: string; name: string | null; avatarUrl: string }>;
    } | null;
  }>(
    `query AssignableUsers($owner: String!, $repo: String!, $query: String) {
      repository(owner: $owner, name: $repo) {
        assignableUsers(first: 20, query: $query) { nodes { login name avatarUrl } }
      }
    }`,
    { owner: ref.owner, repo: ref.repo, query: query.trim() || null },
    token,
    apiBase,
  ).pipe(
    Effect.map((data) =>
      nodesOf(data.repository?.assignableUsers).map((u) => ({
        login: u.login,
        name: u.name?.trim() || null,
        avatarContent: null,
        avatarUrl: u.avatarUrl,
      })),
    ),
  );
}

/**
 * Org teams that can be asked to review, filtered by a search string. A
 * personal repo has no org, and a token without `read:org` sees none; both
 * answer an empty list rather than an error.
 */
export function searchOrgTeams(
  ref: RepoRef,
  query: string,
  token: string,
  apiBase: string,
): Effect.Effect<TeamOption[], GitHubError> {
  return githubGraphql<{
    organization: {
      teams: RawConnection<{ slug: string; name: string; combinedSlug: string }>;
    } | null;
  }>(
    `query ReviewTeams($org: String!, $query: String) {
      organization(login: $org) {
        teams(first: 20, query: $query, orderBy: { field: NAME, direction: ASC }) {
          nodes { slug name combinedSlug }
        }
      }
    }`,
    { org: ref.owner, query: query.trim() || null },
    token,
    apiBase,
  ).pipe(
    Effect.map((data) =>
      nodesOf(data.organization?.teams).map((t) => ({
        combinedSlug: t.combinedSlug,
        slug: t.slug,
        name: t.name,
      })),
    ),
    Effect.catchIf(
      (e) => e instanceof GitHubApiError || e instanceof GitHubAccessDeniedError,
      () => Effect.succeed([]),
    ),
  );
}
