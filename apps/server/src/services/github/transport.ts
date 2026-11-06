/**
 * The one HTTP transport to GitHub. Every request — REST, GraphQL, OAuth,
 * avatar bytes — goes through {@link send}, so each gets the request timeout,
 * the call ledger's origin, a span with the rate-limit budget left, and the
 * same status classification.
 *
 * Only modules under `services/github/` import this file (see
 * `scripts/check-import-boundaries.ts`); everything else reaches GitHub
 * through `GitHubGateway` with a {@link GitHubClient}.
 */
import { Effect, Schedule } from "effect";
import {
  GitHubAccessDeniedError,
  GitHubApiError,
  GitHubAuthError,
  type GitHubError,
  GitHubNetworkError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from "../../domain/errors";
import { apiBaseForHost } from "../../domain/github-host";
import { githubTryPromise } from "../../observability/github-ledger/origin";
import { buildCacheKey, type EtagCache } from "../GitHubEtagCache";

/**
 * Who a request is made as and where it goes. Minted only by `GitHubAccounts`
 * (`PrContext` hands out the one of the account that owns a repo); never
 * derived from the settings host.
 */
export interface GitHubClient {
  readonly host: string;
  readonly apiBase: string;
  readonly token: string;
  /** The `account` row the token belongs to; null only before that row exists (sign-in). */
  readonly accountId: string | null;
}

export function githubClient(host: string, token: string, accountId: string | null): GitHubClient {
  return { host, apiBase: apiBaseForHost(host), token, accountId };
}

const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const retrySchedule = Schedule.max([Schedule.exponential("2 seconds"), Schedule.recurs(3)]);

const isTransientGitHubError = (e: GitHubError): boolean => e instanceof GitHubNetworkError;

export const retryTransient = <A, R>(
  effect: Effect.Effect<A, GitHubError, R>,
): Effect.Effect<A, GitHubError, R> =>
  effect.pipe(Effect.retry({ schedule: retrySchedule, while: isTransientGitHubError }));

export const retryTransientBeforeFallback = <A, R>(
  effect: Effect.Effect<A, GitHubError, R>,
): Effect.Effect<A, GitHubError, R> =>
  effect.pipe(
    Effect.retry({
      schedule: retrySchedule,
      while: (e) => isTransientGitHubError(e) && graphqlErrorsOf(e) === null,
    }),
  );

function toGitHubError(e: unknown): GitHubError {
  if (
    e instanceof GitHubAuthError ||
    e instanceof GitHubAccessDeniedError ||
    e instanceof GitHubRateLimitError ||
    e instanceof GitHubNotFoundError ||
    e instanceof GitHubApiError ||
    e instanceof GitHubNetworkError
  ) {
    return e;
  }
  return new GitHubNetworkError({ cause: e });
}

function authHeaders(client: GitHubClient): Record<string, string> {
  return {
    Authorization: `Bearer ${client.token}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function urlFor(client: GitHubClient, path: string): string {
  return /^https?:\/\//.test(path) ? path : `${client.apiBase}${path}`;
}

async function send(url: string, init: RequestInit, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    const name = typeof e === "object" && e !== null && "name" in e ? String(e.name) : "";
    if (name === "AbortError") {
      throw new GitHubNetworkError({
        cause: `Request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms for ${label}`,
      });
    }
    const detail = e instanceof Error && e.message ? `${e.name}: ${e.message}` : String(e);
    throw new GitHubNetworkError({ cause: `${detail} for ${label}` });
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

/**
 * Throw the domain error for a failed response. A rejection GitHub explains in
 * its body (a 422's validation message, a merge's 405) keeps that body in the
 * error's cause.
 */
async function assertOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 401) {
    throw new GitHubAuthError({ message: "Invalid or expired GitHub token" });
  }
  if (res.status === 403 || res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
    if (retryAfter !== null) {
      throw new GitHubRateLimitError({
        resetAt: new Date(Date.now() + retryAfter * 1000),
        retryAfter,
        kind: "secondary",
      });
    }
    const remaining = res.headers.get("X-RateLimit-Remaining");
    if (res.status === 403 && remaining === "0") {
      const resetHeader = res.headers.get("X-RateLimit-Reset");
      const resource = res.headers.get("X-RateLimit-Resource");
      throw new GitHubRateLimitError({
        resetAt: resetHeader ? new Date(Number(resetHeader) * 1000) : new Date(),
        kind: "primary",
        ...(resource ? { resource } : {}),
      });
    }
    if (res.status === 429) {
      throw new GitHubRateLimitError({
        resetAt: new Date(Date.now() + 60_000),
        retryAfter: 60,
        kind: "secondary",
      });
    }
    throw new GitHubAccessDeniedError({
      resource: label,
      message: `Access denied for ${label} (check GitHub org OAuth app policies)`,
    });
  }
  if (res.status === 404) throw new GitHubNotFoundError({ resource: label, id: label });
  // 5xx and 408 are the only statuses worth replaying: GitHub is having a bad
  // moment and the identical request may succeed. Every other status is a
  // considered rejection.
  if (res.status >= 500 || res.status === 408) {
    throw new GitHubNetworkError({ cause: `HTTP ${res.status} for ${label}` });
  }
  const text = await res.text().catch(() => "");
  throw new GitHubApiError({
    status: res.status,
    cause: `HTTP ${res.status} for ${label}${text ? `: ${text}` : ""}`,
  });
}

function annotate(res: Response): Effect.Effect<void> {
  const remaining = res.headers.get("x-ratelimit-remaining");
  return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("http.response.status_code", res.status);
    if (remaining != null && remaining !== "") {
      yield* Effect.annotateCurrentSpan("github.rate_limit_remaining", Number(remaining));
    }
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

export function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  return linkHeader.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

export interface RequestSpec {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** An API path (`/repos/…`), or an absolute URL (a `Link: next` page). */
  readonly path: string;
  readonly body?: unknown;
  readonly accept?: string;
  /** Non-2xx statuses that answer the question instead of failing (a collaborator check's 404). */
  readonly answered?: readonly number[];
}

/**
 * One request and its response, classified. The response comes back only when
 * it is 2xx or one of `spec.answered`; every other status fails with its
 * domain error.
 */
function exchange<A>(
  client: GitHubClient,
  spec: RequestSpec,
  read: (res: Response) => Promise<A>,
  init: { readonly headers?: Record<string, string>; readonly redirect?: RequestRedirect } = {},
): Effect.Effect<{ readonly status: number; readonly value: A }, GitHubError> {
  const method = spec.method ?? "GET";
  return Effect.withSpan("GitHub.request", {
    attributes: { path: spec.path, method },
  })(
    Effect.gen(function* () {
      const headers: Record<string, string> = { ...authHeaders(client), ...init.headers };
      if (spec.accept) headers.Accept = spec.accept;
      if (spec.body !== undefined) headers["Content-Type"] = "application/json";
      const res = yield* githubTryPromise({
        try: () =>
          send(
            urlFor(client, spec.path),
            {
              method,
              headers,
              ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
              ...(init.redirect ? { redirect: init.redirect } : {}),
            },
            spec.path,
          ),
        catch: toGitHubError,
      });
      yield* annotate(res);
      return yield* githubTryPromise({
        try: async () => {
          const answered = spec.answered?.includes(res.status) === true;
          if (!answered && !(init.redirect === "manual" && res.status >= 300 && res.status < 400)) {
            await assertOk(res, spec.path);
          }
          return { status: res.status, value: await read(res) };
        },
        catch: toGitHubError,
      });
    }),
  );
}

/** Callbacks the gateway hands the transport so an account's failures reach `GitHubAccounts`. */
export interface TransportObserver {
  readonly unauthorized: (client: GitHubClient) => Effect.Effect<void>;
  readonly rateLimited: (client: GitHubClient, error: GitHubRateLimitError) => Effect.Effect<void>;
}

/**
 * The transport, bound to the ETag cache (for {@link GitHubHttp.conditional})
 * and an observer. `GitHubAccounts` builds its own, unobserved, for the token
 * refresh and `/user` probe it makes while handling a failure.
 */
export interface GitHubHttp {
  /** The response body as JSON, or null when empty. */
  readonly json: (client: GitHubClient, spec: RequestSpec) => Effect.Effect<unknown, GitHubError>;
  /** Status and JSON body, for endpoints whose status carries the answer (`/stats/*` 202). */
  readonly status: (
    client: GitHubClient,
    spec: RequestSpec,
  ) => Effect.Effect<{ readonly status: number; readonly body: unknown }, GitHubError>;
  readonly bytes: (
    client: GitHubClient,
    spec: RequestSpec,
  ) => Effect.Effect<Uint8Array, GitHubError>;
  /**
   * A GET that replays the cached body on a 304 — free against the REST
   * primary limit. Keyed on the account, so a refreshed token keeps its cache.
   */
  readonly conditional: (client: GitHubClient, path: string) => Effect.Effect<unknown, GitHubError>;
  /**
   * Every page of an array endpoint, following `Link: next`. With
   * `canReplayCached`, the first page is conditional and a 304 replays the
   * whole cached list when the predicate allows it.
   */
  readonly pages: (
    client: GitHubClient,
    path: string,
    options: {
      readonly maxPages: number;
      readonly canReplayCached?: (cached: readonly unknown[]) => boolean;
    },
  ) => Effect.Effect<unknown[], GitHubError>;
  /**
   * GET an endpoint that redirects to a short-lived download URL (Actions job
   * logs) and read the target as text. The redirect is followed by hand so
   * the token never travels to the storage host.
   */
  readonly redirectText: (client: GitHubClient, path: string) => Effect.Effect<string, GitHubError>;
  readonly graphql: <T>(
    client: GitHubClient,
    query: string,
    variables: Record<string, unknown>,
  ) => Effect.Effect<T, GitHubError>;
  /**
   * {@link graphql} for aliased queries: GitHub answers a field it can't
   * resolve (repo renamed, access revoked) with `null` plus an `errors` entry,
   * and that one field must not fail the rest. Hands back the `errors` too,
   * for callers that must tell which fields came back null and why.
   */
  readonly graphqlPartial: <T>(
    client: GitHubClient,
    query: string,
    variables: Record<string, unknown>,
  ) => Effect.Effect<
    { readonly data: T; readonly errors: ReadonlyArray<GraphqlError> },
    GitHubError
  >;
}

export function makeHttp(
  etagCache: EtagCache | null,
  observer: TransportObserver | null,
): GitHubHttp {
  const observed = <A>(
    client: GitHubClient,
    effect: Effect.Effect<A, GitHubError>,
  ): Effect.Effect<A, GitHubError> =>
    observer === null || client.accountId === null
      ? effect
      : effect.pipe(
          Effect.tapError((err) =>
            err instanceof GitHubAuthError
              ? observer.unauthorized(client)
              : err instanceof GitHubRateLimitError
                ? observer.rateLimited(client, err)
                : Effect.void,
          ),
        );

  const cacheKey = (client: GitHubClient, path: string): string => {
    const separator = path.includes("?") ? "&" : "?";
    const scope = client.accountId ?? client.token;
    return buildCacheKey("GET", `${client.apiBase}${path}${separator}viewer=${scope}`);
  };

  const conditionalPages = (
    client: GitHubClient,
    path: string,
    maxPages: number,
    canReplayCached: ((cached: readonly unknown[]) => boolean) | null,
  ): Effect.Effect<{ readonly body: unknown; readonly hit: boolean }, GitHubError> =>
    Effect.gen(function* () {
      const key = cacheKey(client, path);
      const cached = etagCache && canReplayCached !== null ? yield* etagCache.get(key) : null;
      const first = yield* exchange(
        client,
        { path, answered: cached ? [304] : [] },
        async (res) => ({
          etag: res.headers.get("ETag"),
          lastModified: res.headers.get("Last-Modified"),
          next: parseLinkNext(res.headers.get("Link")),
          body: res.status === 304 ? null : await readJson(res),
        }),
        cached ? { headers: { "If-None-Match": cached.etag } } : {},
      );
      if (canReplayCached !== null) {
        yield* Effect.annotateCurrentSpan("cache", first.status === 304 ? "hit" : "miss");
      }
      if (first.status === 304 && cached) {
        const replayable =
          maxPages === 0 ||
          (Array.isArray(cached.body) && (canReplayCached?.(cached.body) ?? false));
        if (replayable) {
          etagCache?.recordHit(JSON.stringify(cached.body ?? null).length);
          return { body: cached.body, hit: true };
        }
      }
      let firstBody = first.value.body;
      let next = first.value.next;
      if (first.status === 304) {
        // The cached list can't be replayed (it may be truncated): read it again.
        const again = yield* exchange(client, { path }, async (res) => ({
          next: parseLinkNext(res.headers.get("Link")),
          body: await readJson(res),
        }));
        firstBody = again.value.body;
        next = again.value.next;
      }
      if (canReplayCached !== null) etagCache?.recordMiss();
      let body: unknown = firstBody;
      if (maxPages > 0) {
        const items: unknown[] = Array.isArray(firstBody) ? [...firstBody] : [];
        for (let page = 1; page < maxPages && next; page++) {
          const res = yield* exchange(client, { path: next }, async (r) => ({
            next: parseLinkNext(r.headers.get("Link")),
            body: await readJson(r),
          }));
          if (Array.isArray(res.value.body)) items.push(...res.value.body);
          next = res.value.next;
        }
        body = items;
      }
      if (etagCache && canReplayCached !== null && first.value.etag) {
        yield* etagCache.put(key, first.value.etag, first.value.lastModified, body);
      }
      return { body, hit: false };
    });

  const postGraphql = <T>(
    client: GitHubClient,
    query: string,
    variables: Record<string, unknown>,
    tolerateErrors: boolean,
  ): Effect.Effect<{ data: T; errors: ReadonlyArray<GraphqlError> }, GitHubError> => {
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unknown";
    return Effect.withSpan("GitHub.graphql", { attributes: { operationName } })(
      exchange(
        client,
        { method: "POST", path: "/graphql", body: { query, variables } },
        async (res) => ({
          payload: (await res.json()) as GraphqlPayload<T>,
          resetHeader: res.headers.get("X-RateLimit-Reset"),
        }),
      ).pipe(
        Effect.flatMap(({ status, value: { payload, resetHeader } }) =>
          Effect.try({
            try: () => classifyGraphql(payload, status, resetHeader, tolerateErrors),
            catch: toGitHubError,
          }),
        ),
      ),
    );
  };

  return {
    json: (client, spec) =>
      observed(client, exchange(client, spec, readJson).pipe(Effect.map((r) => r.value))),
    status: (client, spec) =>
      observed(
        client,
        exchange(client, spec, readJson).pipe(
          Effect.map((r) => ({ status: r.status, body: r.value })),
        ),
      ),
    bytes: (client, spec) =>
      observed(
        client,
        exchange(client, spec, async (res) => new Uint8Array(await res.arrayBuffer())).pipe(
          Effect.map((r) => r.value),
        ),
      ),
    conditional: (client, path) =>
      observed(
        client,
        conditionalPages(client, path, 0, () => true).pipe(Effect.map((r) => r.body)),
      ),
    pages: (client, path, { maxPages, canReplayCached }) =>
      observed(
        client,
        conditionalPages(client, path, Math.max(1, maxPages), canReplayCached ?? null).pipe(
          Effect.map((r) => [...(r.body as unknown[])]),
        ),
      ),
    redirectText: (client, path) =>
      observed(
        client,
        exchange(
          client,
          { path, answered: [410] },
          async (res) => {
            const location = res.headers.get("Location");
            if (res.status >= 300 && res.status < 400 && location) {
              const target = await send(location, {}, path);
              if (!target.ok) {
                throw new GitHubApiError({
                  status: target.status,
                  cause: `HTTP ${target.status} for ${path} (download)`,
                });
              }
              return target.text();
            }
            if (res.status === 410) {
              throw new GitHubApiError({ status: 410, cause: `HTTP 410 for ${path}` });
            }
            return res.text();
          },
          { redirect: "manual" },
        ).pipe(Effect.map((r) => r.value)),
      ),
    graphql: <T>(client: GitHubClient, query: string, variables: Record<string, unknown>) =>
      observed(
        client,
        postGraphql<T>(client, query, variables, false).pipe(Effect.map((r) => r.data)),
      ),
    graphqlPartial: <T>(client: GitHubClient, query: string, variables: Record<string, unknown>) =>
      observed(client, postGraphql<T>(client, query, variables, true)),
  };
}

export interface GraphqlError {
  readonly message: string;
  readonly type?: string;
  /** Where in `data` the failed field sits, e.g. `["repository", "pullRequest"]`. */
  readonly path?: ReadonlyArray<string | number>;
}

interface GraphqlPayload<T> {
  readonly data?: T | null;
  readonly errors?: ReadonlyArray<GraphqlError>;
}

/**
 * GitHub's answer when a query fails on its side ("Something went wrong while
 * executing your query. This may be the result of a timeout…", or on GitHub
 * Enterprise "…executing your query on <time>. Please include `<id>`…").
 */
function isGraphqlServerFailure(message: string): boolean {
  return message.startsWith("Something went wrong while executing your query");
}

export class GraphqlErrorAnswer {
  constructor(readonly errors: ReadonlyArray<GraphqlError>) {}

  toString(): string {
    return `GraphQL: ${this.errors.map((e) => e.message).join("; ") || "empty data field"}`;
  }
}

export function graphqlErrorsOf(err: GitHubError): ReadonlyArray<GraphqlError> | null {
  return (err instanceof GitHubApiError || err instanceof GitHubNetworkError) &&
    err.cause instanceof GraphqlErrorAnswer
    ? err.cause.errors
    : null;
}

function classifyGraphql<T>(
  payload: GraphqlPayload<T>,
  status: number,
  resetHeader: string | null,
  tolerateErrors: boolean,
): { data: T; errors: ReadonlyArray<GraphqlError> } {
  // GraphQL's primary limit answers 200 with a `RATE_LIMITED` error. GraphQL
  // has its own budget, so this must not read as the REST budget running out.
  if (payload.errors?.some((e) => e.type === "RATE_LIMITED")) {
    throw new GitHubRateLimitError({
      resetAt: resetHeader ? new Date(Number(resetHeader) * 1000) : new Date(),
      kind: "primary",
      resource: "graphql",
    });
  }
  // GitHub's own failure, in a 200 (a query that ran out of time). The next
  // ask usually answers, so it is transient, like the 5xx it stands in for.
  const failed = payload.errors?.find((e) => isGraphqlServerFailure(e.message));
  if (failed) throw new GitHubNetworkError({ cause: new GraphqlErrorAnswer([failed]) });
  // Any other 200 carrying `errors` is GraphQL rejecting the query (unknown
  // field, missing scope, node not visible): a stable verdict, not retryable.
  if (!tolerateErrors && payload.errors && payload.errors.length > 0) {
    throw new GitHubApiError({ status, cause: new GraphqlErrorAnswer(payload.errors) });
  }
  // A query refused outright (an unknown field on an older GitHub Enterprise)
  // has no `data`. Its errors tell a schema complaint from any other failure.
  if (!payload.data) {
    throw new GitHubApiError({ status, cause: new GraphqlErrorAnswer(payload.errors ?? []) });
  }
  return { data: payload.data, errors: payload.errors ?? [] };
}

/**
 * Ask a GraphQL query that names fields an older GitHub Enterprise may lack.
 * GraphQL rejects the whole query on one unknown field or enum value, so a
 * refusal naming any of `modernTokens` earns one retry with `ask(false)`, the
 * query without them. Reports which shape answered, for follow-up queries
 * that must match it.
 *
 * `anyGraphqlFailure` widens the retry to every failure GraphQL answered, for
 * modern fields that are optional garnish. `outdated` then tells a host that
 * lacks the fields apart from one that failed on them this once.
 */
export function withSchemaFallback<A, R>(
  ask: (modern: boolean) => Effect.Effect<A, GitHubError, R>,
  modernTokens: readonly string[],
  options: { readonly anyGraphqlFailure?: boolean } = {},
): Effect.Effect<
  { readonly value: A; readonly modern: boolean; readonly outdated: boolean },
  GitHubError,
  R
> {
  const outdated = (err: GitHubError) => {
    if (!(err instanceof GitHubApiError)) return false;
    const messages = graphqlErrorsOf(err)?.map((e) => e.message) ?? [String(err.cause)];
    return messages.some((message) => modernTokens.some((token) => message.includes(token)));
  };
  return ask(true).pipe(
    Effect.map((value) => ({ value, modern: true, outdated: false })),
    Effect.catch((err) =>
      outdated(err) || (options.anyGraphqlFailure === true && graphqlErrorsOf(err) !== null)
        ? ask(false).pipe(
            Effect.map((value) => ({ value, modern: false, outdated: outdated(err) })),
          )
        : Effect.fail(err),
    ),
  );
}

export interface GraphqlConnection<N> {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly nodes: ReadonlyArray<N | null>;
}

/**
 * Walk a cursor-paginated GraphQL connection. The query must declare a
 * `$cursor: String` variable and pass it as the connection's `after`.
 *
 * `selectConnection` returning nothing means the parent node isn't there (repo
 * or PR not visible to the token) and fails with `notFound()`.
 */
export function paginateGraphql<T, N>(
  http: GitHubHttp,
  client: GitHubClient,
  opts: {
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly selectConnection: (data: T) => GraphqlConnection<N> | null | undefined;
    readonly maxPages: number;
    readonly notFound: () => GitHubError;
    readonly stopAfter?: (page: readonly N[]) => boolean;
  },
): Effect.Effect<N[], GitHubError> {
  return Effect.gen(function* () {
    const out: N[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < opts.maxPages; page++) {
      const data: T = yield* http.graphql<T>(client, opts.query, { ...opts.variables, cursor });
      const connection = opts.selectConnection(data);
      if (!connection) return yield* Effect.fail(opts.notFound());
      const nodes = connection.nodes.filter((node): node is N => node !== null);
      out.push(...nodes);
      if (!connection.pageInfo.hasNextPage || opts.stopAfter?.(nodes)) break;
      cursor = connection.pageInfo.endCursor;
    }
    return out;
  });
}

/**
 * Fetch an image (an avatar) as a `data:` URL. Sent without credentials: on
 * GitHub Enterprise the URL carries its own short-lived signature.
 */
export function fetchDataUrl(url: string): Effect.Effect<string, GitHubError> {
  return Effect.withSpan("GitHub.request", { attributes: { path: url, method: "GET" } })(
    githubTryPromise({
      try: async () => {
        const res = await send(url, {}, url);
        if (!res.ok) {
          throw new GitHubApiError({ status: res.status, cause: `HTTP ${res.status} for ${url}` });
        }
        const contentType = res.headers.get("content-type") ?? "image/png";
        const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
        return `data:${contentType};base64,${base64}`;
      },
      catch: toGitHubError,
    }),
  );
}

/**
 * POST to a host's OAuth endpoints (`/login/device/code`,
 * `/login/oauth/access_token`). GitHub answers these with a JSON body whatever
 * the outcome, so the status and body come back unclassified.
 */
export function oauthPost(
  host: string,
  path: string,
  params: Record<string, string>,
): Effect.Effect<
  { readonly status: number; readonly statusText: string; readonly text: string },
  GitHubError
> {
  return Effect.withSpan("GitHub.request", { attributes: { path, method: "POST" } })(
    githubTryPromise({
      try: async () => {
        const res = await send(
          `https://${host}${path}`,
          {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(params),
          },
          path,
        );
        return { status: res.status, statusText: res.statusText, text: await res.text() };
      },
      catch: toGitHubError,
    }),
  );
}
