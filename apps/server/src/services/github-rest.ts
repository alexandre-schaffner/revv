import { createHash } from "node:crypto";
import { Effect, Schedule } from "effect";
import {
  GitHubAccessDeniedError,
  GitHubAuthError,
  type GitHubError,
  GitHubNetworkError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from "../domain/errors";
import type { DbService } from "./Db";
import { buildCacheKey, GitHubEtagCache } from "./GitHubEtagCache";

const retrySchedule = Schedule.intersect(Schedule.exponential("2 seconds"), Schedule.recurs(3));
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

const isTransientGitHubError = (e: GitHubError): boolean => e instanceof GitHubNetworkError;

export const retryTransient = <A, R>(
  effect: Effect.Effect<A, GitHubError, R>,
): Effect.Effect<A, GitHubError, R> =>
  effect.pipe(Effect.retry({ schedule: retrySchedule, while: isTransientGitHubError }));

function cacheKeyForRequest(apiBase: string, path: string, token: string): string {
  const separator = path.includes("?") ? "&" : "?";
  const tokenScope = createHash("sha256").update(token).digest("hex");
  return buildCacheKey("GET", `${apiBase}${path}${separator}viewer=${tokenScope}`);
}

/** Pass through known GitHub errors; wrap unknown ones in GitHubNetworkError. */
export function toGitHubError(e: unknown): GitHubError {
  if (
    e instanceof GitHubAuthError ||
    e instanceof GitHubAccessDeniedError ||
    e instanceof GitHubRateLimitError ||
    e instanceof GitHubNotFoundError ||
    e instanceof GitHubNetworkError
  ) {
    return e;
  }
  return new GitHubNetworkError({ cause: e });
}

/** Build the standard headers for GitHub API requests. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubHttpFetch(url: string, init: RequestInit, path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (e) {
    const name = typeof e === "object" && e !== null && "name" in e ? String(e.name) : "";
    if (name === "AbortError") {
      throw new GitHubNetworkError({
        cause: `Request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms for ${path}`,
      });
    }
    const detail = e instanceof Error && e.message ? `${e.name}: ${e.message}` : String(e);
    throw new GitHubNetworkError({ cause: `${detail} for ${path}` });
  } finally {
    clearTimeout(timer);
  }
}

/** Assert a fetch response is successful, throwing the appropriate domain error on failure. */
export function assertGitHubOk(res: Response, path: string): void {
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
      const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : new Date();
      const resource = res.headers.get("X-RateLimit-Resource");
      throw new GitHubRateLimitError({
        resetAt,
        kind: "primary",
        ...(resource ? { resource } : {}),
      });
    }

    if (res.status === 429) {
      const defaultRetryAfter = 60;
      throw new GitHubRateLimitError({
        resetAt: new Date(Date.now() + defaultRetryAfter * 1000),
        retryAfter: defaultRetryAfter,
        kind: "secondary",
      });
    }

    throw new GitHubAccessDeniedError({
      resource: path,
      message: `Access denied for ${path} (check GitHub org OAuth app policies)`,
    });
  }
  if (res.status === 404) {
    throw new GitHubNotFoundError({ resource: path, id: path });
  }
  if (!res.ok) {
    throw new GitHubNetworkError({ cause: `HTTP ${res.status}` });
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

export function githubFetch(
  path: string,
  token: string,
  apiBase: string,
): Effect.Effect<unknown, GitHubError> {
  return Effect.withSpan("GitHub.fetch", {
    attributes: { path, method: "GET" },
  })(
    Effect.tryPromise({
      try: async () => {
        const res = await githubHttpFetch(
          `${apiBase}${path}`,
          {
            headers: githubHeaders(token),
          },
          path,
        );
        assertGitHubOk(res, path);
        return res.json();
      },
      catch: toGitHubError,
    }),
  );
}

export function conditionalFetch(
  path: string,
  token: string,
  apiBase: string,
): Effect.Effect<unknown, GitHubError, DbService | GitHubEtagCache> {
  return Effect.gen(function* () {
    const cache = yield* GitHubEtagCache;
    const cacheKey = cacheKeyForRequest(apiBase, path, token);
    const cached = yield* cache.get(cacheKey);

    const result = yield* Effect.tryPromise({
      try: async () => {
        const headers: Record<string, string> = githubHeaders(token);
        if (cached) {
          headers["If-None-Match"] = cached.etag;
        }
        const res = await githubHttpFetch(`${apiBase}${path}`, { headers }, path);

        if (res.status === 304 && cached) {
          return { kind: "hit" as const, body: cached.body, bytes: 0 };
        }

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
      recordCacheHit(cache, result.body);
      return result.body;
    }

    cache.recordMiss();
    if (result.etag) {
      yield* cache.put(cacheKey, result.etag, result.lastModified ?? null, result.body);
    }
    return result.body;
  });
}

export function conditionalFetchPaginated(
  path: string,
  token: string,
  maxPages: number = 3,
  apiBase: string,
  options: {
    readonly canReplayCached?: (cached: readonly unknown[]) => boolean;
  } = {},
): Effect.Effect<unknown[], GitHubError, DbService | GitHubEtagCache> {
  return Effect.withSpan("GitHub.fetchPaginated.conditional", {
    attributes: { path, maxPages },
  })(
    Effect.gen(function* () {
      const cache = yield* GitHubEtagCache;
      const cacheKey = cacheKeyForRequest(apiBase, path, token);
      const cached = yield* cache.get(cacheKey);

      const result = yield* Effect.tryPromise({
        try: async () => {
          const headers: Record<string, string> = githubHeaders(token);
          if (cached) {
            headers["If-None-Match"] = cached.etag;
          }

          const firstUrl = `${apiBase}${path}`;
          let firstResponse = await githubHttpFetch(firstUrl, { headers }, path);

          if (firstResponse.status === 304 && cached) {
            if (Array.isArray(cached.body)) {
              const replayAllowed = options.canReplayCached?.(cached.body) ?? false;
              if (replayAllowed) {
                return { kind: "hit" as const, body: cached.body };
              }
            }

            firstResponse = await githubHttpFetch(
              firstUrl,
              { headers: githubHeaders(token) },
              path,
            );
          }

          const results: unknown[] = [];
          let url: string | null = firstUrl;
          let etag: string | null = null;
          let lastModified: string | null = null;
          let bytes = 0;

          for (let page = 0; page < maxPages && url; page++) {
            const res =
              page === 0
                ? firstResponse
                : await githubHttpFetch(url, { headers: githubHeaders(token) }, path);
            assertGitHubOk(res, path);

            if (page === 0) {
              etag = res.headers.get("ETag");
              lastModified = res.headers.get("Last-Modified");
            }

            const bodyText = await res.text();
            bytes += bodyText.length;
            const data = bodyText ? JSON.parse(bodyText) : [];
            if (Array.isArray(data)) {
              results.push(...data);
            }

            url = parseLinkNext(res.headers.get("Link"));
          }

          return {
            kind: "miss" as const,
            body: results,
            bytes,
            etag,
            lastModified,
          };
        },
        catch: toGitHubError,
      });

      if (result.kind === "hit") {
        recordCacheHit(cache, result.body);
        return [...result.body];
      }

      cache.recordMiss();
      if (result.etag) {
        yield* cache.put(cacheKey, result.etag, result.lastModified, result.body);
      }
      return result.body;
    }),
  );
}

function recordCacheHit(
  cache: { readonly recordHit: (bodyByteSize: number) => void },
  body: unknown,
): void {
  let saved = 0;
  try {
    saved = JSON.stringify(body).length;
  } catch {
    /* stats are best-effort */
  }
  cache.recordHit(saved);
}

export function githubPost(
  path: string,
  token: string,
  body: Record<string, unknown>,
  apiBase: string,
): Effect.Effect<unknown, GitHubError> {
  return Effect.withSpan("GitHub.post", {
    attributes: { path, method: "POST" },
  })(
    Effect.tryPromise({
      try: async () => {
        const res = await githubHttpFetch(
          `${apiBase}${path}`,
          {
            method: "POST",
            headers: { ...githubHeaders(token), "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          path,
        );
        if (res.status === 422) {
          const text = await res.text().catch(() => "");
          throw new GitHubNetworkError({ cause: `422 Unprocessable Entity: ${text}` });
        }
        assertGitHubOk(res, path);
        return res.json();
      },
      catch: toGitHubError,
    }),
  );
}

export function githubPatch(
  path: string,
  token: string,
  body: Record<string, unknown>,
  apiBase: string,
): Effect.Effect<unknown, GitHubError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await githubHttpFetch(
        `${apiBase}${path}`,
        {
          method: "PATCH",
          headers: { ...githubHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        path,
      );
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

export function githubPut(
  path: string,
  token: string,
  body: Record<string, unknown>,
  apiBase: string,
): Effect.Effect<unknown, GitHubError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await githubHttpFetch(
        `${apiBase}${path}`,
        {
          method: "PUT",
          headers: { ...githubHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        path,
      );
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

export function githubGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
  apiBase: string,
): Effect.Effect<T, GitHubError> {
  const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unknown";
  return Effect.withSpan("GitHub.graphql", {
    attributes: { operationName },
  })(
    Effect.tryPromise({
      try: async () => {
        const res = await githubHttpFetch(
          `${apiBase}/graphql`,
          {
            method: "POST",
            headers: { ...githubHeaders(token), "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables }),
          },
          "/graphql",
        );
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
    }),
  );
}

export function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

export function githubFetchPaginated(
  path: string,
  token: string,
  maxPages: number = 3,
  apiBase: string,
): Effect.Effect<unknown[], GitHubError> {
  return Effect.withSpan("GitHub.fetchPaginated", {
    attributes: { path, maxPages },
  })(
    Effect.tryPromise({
      try: async () => {
        const results: unknown[] = [];
        let url: string | null = `${apiBase}${path}`;

        for (let page = 0; page < maxPages && url; page++) {
          const res = await githubHttpFetch(
            url,
            {
              headers: githubHeaders(token),
            },
            path,
          );
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
    }),
  );
}
