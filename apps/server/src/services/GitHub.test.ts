import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Either, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { GitHubApiError, GitHubNotFoundError, GitHubRateLimitError } from "../domain/errors";
import { DbService } from "./Db";
import { GitHubGateway, GitHubGatewayLive } from "./GitHub";
import { GitHubEtagCacheLive } from "./GitHubEtagCache";
import { SettingsServiceLive } from "./Settings";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface FetchCall {
  readonly url: string;
  readonly headers: Headers;
}

function gatewayLayer(db: Db) {
  const dbLayer = Layer.succeed(DbService, { db });
  const dependent = Layer.mergeAll(GitHubEtagCacheLive, SettingsServiceLive).pipe(
    Layer.provide(dbLayer),
  );
  return Layer.mergeAll(GitHubGatewayLive, dbLayer, dependent);
}

function responseJson(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

function stubFetch(respond: (call: FetchCall, index: number) => Response) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function rawComment(id: number): Record<string, unknown> {
  return {
    id,
    in_reply_to_id: null,
    path: "src/app.ts",
    line: 10,
    start_line: null,
    side: "RIGHT",
    body: `comment ${id}`,
    user: { login: "reviewer", avatar_url: null },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.test/comment/${id}`,
  };
}

function rawPr(number: number): Record<string, unknown> {
  return {
    number,
    user: { login: "author", avatar_url: null },
    head: { ref: "feature", sha: `head-${number}` },
    base: { ref: "main", sha: "base" },
    requested_reviewers: [],
    title: `PR ${number}`,
    body: null,
    state: "open",
    merged_at: null,
    draft: false,
    html_url: `https://github.test/pull/${number}`,
    additions: 1,
    deletions: 1,
    changed_files: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
  };
}

function gqlPr(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    body: "",
    isDraft: false,
    url: `https://github.test/pull/${number}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    headRefName: "feature",
    baseRefName: "main",
    headRefOid: `head-${number}`,
    baseRefOid: "base",
    author: { __typename: "User", login: "author", avatarUrl: null },
    reviewRequests: { nodes: [] },
    ...overrides,
  };
}

function gqlPrPage(
  nodes: Record<string, unknown>[],
  endCursor: string | null = null,
): Record<string, unknown> {
  return {
    data: {
      repository: {
        pullRequests: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
      },
    },
  };
}

function rawPrFile(filename: string): Record<string, unknown> {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: `@@ -1 +1 @@\n-${filename}\n+${filename}`,
  };
}

describe("GitHubGateway rate-limit handling", () => {
  it("classifies Retry-After responses as rate limits without retrying", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(
      () =>
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs
          .listOpen("octo/repo", "repo-1", "token", "https://api.github.test")
          .pipe(Effect.either);
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(calls).toHaveLength(1);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(GitHubRateLimitError);
      expect(result.left._tag).toBe("GitHubRateLimitError");
      if (result.left._tag === "GitHubRateLimitError") {
        expect(result.left.kind).toBe("secondary");
        expect(result.left.retryAfter).toBe(30);
      }
    }
  });
});

describe("GitHubGateway conditional pagination", () => {
  it("fetches all changed files across paginated PR files responses", async () => {
    const db = createDb(":memory:");
    const firstPage = Array.from({ length: 100 }, (_, i) => rawPrFile(`src/page-${i + 1}.ts`));
    const secondPage = Array.from({ length: 25 }, (_, i) => rawPrFile(`src/page-${i + 101}.ts`));
    const calls = stubFetch((_call, index) => {
      if (index === 0) {
        return responseJson(firstPage, {
          headers: {
            Link: '<https://api.github.test/repos/octo/repo/pulls/1/files?per_page=100&page=2>; rel="next"',
          },
        });
      }
      return responseJson(secondPage);
    });

    const files = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs.files("octo/repo", 1, "token");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(files).toHaveLength(125);
    expect(files[0]?.filename).toBe("src/page-1.ts");
    expect(files.at(-1)?.filename).toBe("src/page-125.ts");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/octo/repo/pulls/1/files?per_page=100");
    expect(calls[1]?.url).toBe(
      "https://api.github.test/repos/octo/repo/pulls/1/files?per_page=100&page=2",
    );
  });

  it("keeps review comments incremental and uncached", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch((_call, index) => {
      if (index === 0) {
        return responseJson([rawComment(1)], { headers: { ETag: '"comments-v1"' } });
      }
      return responseJson([rawComment(2)], { headers: { ETag: '"comments-v2"' } });
    });

    const comments = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        yield* github.reviews.listComments("octo/repo", 1, "2026-01-01T00:00:00Z", "token");
        return yield* github.reviews.listComments("octo/repo", 1, "2026-01-02T00:00:00Z", "token");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/octo/repo/pulls/1/comments?per_page=100&since=2026-01-01T00%3A00%3A00Z",
    );
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/octo/repo/pulls/1/comments?per_page=100&since=2026-01-02T00%3A00%3A00Z",
    );
    expect(calls[1]?.headers.get("If-None-Match")).toBeNull();
  });

  it("refuses to replay a cached review-comment page that was full", async () => {
    const db = createDb(":memory:");
    const fullPage = Array.from({ length: 100 }, (_, i) => rawComment(i + 1));
    const calls = stubFetch((_call, index) => {
      if (index === 0) {
        return responseJson(fullPage, { headers: { ETag: '"comments-v1"' } });
      }
      if (index === 1) {
        return new Response(null, { status: 304 });
      }
      return responseJson([rawComment(999)], { headers: { ETag: '"comments-v2"' } });
    });

    const comments = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        yield* github.reviews.listComments("octo/repo", 1, "2026-01-01T00:00:00Z", "token");
        return yield* github.reviews.listComments("octo/repo", 1, "2026-01-01T00:00:00Z", "token");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    // A full cached page means there may be a page 2 we never saw, so the 304 is
    // discarded and the request repeated unconditionally.
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(999);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.headers.get("If-None-Match")).toBe('"comments-v1"');
    expect(calls[2]?.headers.get("If-None-Match")).toBeNull();
  });
});

// The API base URL is a per-repository property (`repositories.github_host`).
// These pin that an explicitly-passed base wins over the settings-derived
// fallback, which is what keeps a GitHub Enterprise repo's token from being
// sent to api.github.com when both hosts are connected on one machine.
describe("GitHubGateway per-host API base", () => {
  it("honours an explicit apiBase on the PR detail fetch", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(() => responseJson(rawPr(7), { headers: { ETag: '"pr-7"' } }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs.get("octo/repo", 7, "token", "https://api.ghe.example.com");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(calls[0]?.url).toBe("https://api.ghe.example.com/repos/octo/repo/pulls/7");
  });

  it("honours an explicit apiBase on the review-thread GraphQL call", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(() =>
      responseJson({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.reviews.listThreads(
          "octo/repo",
          7,
          "token",
          "https://api.ghe.example.com",
        );
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(calls[0]?.url).toBe("https://api.ghe.example.com/graphql");
  });

  it("falls back to the settings-derived base when none is passed", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(() => responseJson(rawPr(7), { headers: { ETag: '"pr-7"' } }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs.get("octo/repo", 7, "token");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(calls[0]?.url).toBe("https://api.github.com/repos/octo/repo/pulls/7");
  });

  it("separates ETag cache entries by API base and token", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(() => responseJson(rawPr(1), { headers: { ETag: '"pr-1"' } }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        yield* github.prs.get("octo/repo", 1, "token-a", "https://api.github.test");
        yield* github.prs.get("octo/repo", 1, "token-a", "https://api.github.example");
        yield* github.prs.get("octo/repo", 1, "token-b", "https://api.github.test");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers.get("If-None-Match")).toBeNull();
    expect(calls[1]?.headers.get("If-None-Match")).toBeNull();
    expect(calls[2]?.headers.get("If-None-Match")).toBeNull();
  });
});

// `retryTransient` retries `GitHubNetworkError` and nothing else, so what gets
// mapped to it decides whether a failure costs 1 request or 4 requests plus
// ~14s of backoff. In the sequential thread sweep that backoff stalls every PR
// queued behind the failing one, so the split is load-bearing, not cosmetic.
describe("GitHubGateway error classification", () => {
  // One failure only: the retry schedule is exponential from 2s, so failing
  // twice would push this past a sane test timeout without proving anything
  // more than failing once does.
  it("retries a 5xx as transient", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch((_call, index) =>
      index < 1 ? new Response("boom", { status: 503 }) : responseJson(gqlPrPage([gqlPr(1)])),
    );

    const prs = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs.listOpen(
          "octo/repo",
          "repo-1",
          "token",
          "https://api.github.test",
        );
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(prs).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 422", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(() => new Response("bad field", { status: 422 }));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs
          .listOpen("octo/repo", "repo-1", "token", "https://api.github.test")
          .pipe(Effect.either);
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(calls).toHaveLength(1);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(GitHubApiError);
    }
  });

  it("does not retry a GraphQL errors payload", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(() =>
      responseJson({ errors: [{ message: "Field 'nope' doesn't exist" }] }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.reviews.listThreads("octo/repo", 1, "token").pipe(Effect.either);
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(calls).toHaveLength(1);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(GitHubApiError);
      expect(String((result.left as GitHubApiError).cause)).toContain("nope");
    }
  });
});

describe("listPrs", () => {
  const listOpen = (db: Db) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs
          .listOpen("octo/repo", "repo-1", "token", "https://api.github.test")
          .pipe(Effect.either);
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

  it("follows the cursor across pages", async () => {
    const db = createDb(":memory:");
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? responseJson(gqlPrPage([gqlPr(2), gqlPr(1)], "cursor-1"))
        : responseJson(gqlPrPage([gqlPr(3)]));
    }) as typeof fetch;

    const result = await listOpen(db);

    expect(Either.isRight(result) && result.right.map((pr) => pr.externalId)).toEqual([2, 1, 3]);
    expect(bodies).toHaveLength(2);
    expect((bodies[0] as { variables: unknown }).variables).toEqual({
      owner: "octo",
      name: "repo",
      cursor: null,
    });
    expect((bodies[1] as { variables: { cursor: string } }).variables.cursor).toBe("cursor-1");
  });

  // Every other login in the DB came from REST, so a GraphQL row must match
  // what `GET /pulls` would have stored or bot and ghost PRs drift out of the
  // author filters.
  it("maps nodes to the row the REST list produced", async () => {
    const db = createDb(":memory:");
    stubFetch(() =>
      responseJson(
        gqlPrPage([
          gqlPr(1, {
            author: { __typename: "Bot", login: "dependabot", avatarUrl: "https://a.test/bot" },
            reviewRequests: {
              nodes: [
                { requestedReviewer: { __typename: "User", login: "alice" } },
                { requestedReviewer: { __typename: "Team" } },
                { requestedReviewer: null },
              ],
            },
          }),
          gqlPr(2, { author: null, body: "Fixes #1", isDraft: true }),
        ]),
      ),
    );

    const result = await listOpen(db);

    expect(Either.isRight(result)).toBe(true);
    if (!Either.isRight(result)) return;
    const [bot, ghost] = result.right;
    expect(bot).toMatchObject({
      id: "repo-1:1",
      repositoryId: "repo-1",
      authorLogin: "dependabot[bot]",
      authorAvatarUrl: "https://a.test/bot",
      requestedReviewers: ["alice"],
      body: null,
      status: "open",
      headSha: "head-1",
      baseSha: "base",
      sourceBranch: "feature",
      targetBranch: "main",
      additions: 0,
      changedFiles: 0,
    });
    expect(ghost).toMatchObject({ authorLogin: "ghost", body: "Fixes #1", isDraft: true });
  });

  it("classifies a GraphQL RATE_LIMITED answer as a rate limit", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(() =>
      responseJson(
        { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        { headers: { "X-RateLimit-Reset": "1800000000" } },
      ),
    );

    const result = await listOpen(db);

    expect(calls).toHaveLength(1);
    expect(Either.isLeft(result) && result.left).toBeInstanceOf(GitHubRateLimitError);
    if (Either.isLeft(result) && result.left._tag === "GitHubRateLimitError") {
      expect(result.left.resetAt.getTime()).toBe(1_800_000_000_000);
      expect(result.left.resource).toBe("graphql");
    }
  });

  it("fails instead of reporting zero PRs for a repo it cannot see", async () => {
    const db = createDb(":memory:");
    stubFetch(() => responseJson({ data: { repository: null } }));

    const result = await listOpen(db);

    expect(Either.isLeft(result) && result.left).toBeInstanceOf(GitHubNotFoundError);
  });
});

// The fallback for a spent GraphQL budget. It replays a cached 304
// unconditionally, including a multi-page cached set. That is safe *because of
// the sort*: `?sort=updated&direction=desc` moves any changed PR onto page 1, so
// page 1's ETag — the one we send If-None-Match against — moves whenever
// anything anywhere in the list moves. A 304 there genuinely means "no page
// changed", and costs nothing against the REST limit.
describe("listPrsRest", () => {
  it("replays the whole cached open-PR set on a 304, across pages", async () => {
    const db = createDb(":memory:");
    const firstPage = Array.from({ length: 100 }, (_, i) => rawPr(i + 1));
    const calls = stubFetch((_call, index) => {
      if (index === 0) {
        return responseJson(firstPage, {
          headers: {
            ETag: '"prs-v1"',
            Link: '<https://api.github.test/repos/octo/repo/pulls?page=2>; rel="next"',
          },
        });
      }
      if (index === 1) {
        return responseJson([rawPr(101)], { headers: { ETag: '"prs-v1-page2"' } });
      }
      return new Response(null, { status: 304 });
    });

    const prs = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        yield* github.prs.listOpenRest("octo/repo", "repo-1", "token", "https://api.github.test");
        return yield* github.prs.listOpenRest(
          "octo/repo",
          "repo-1",
          "token",
          "https://api.github.test",
        );
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    // Both pages of the first fetch, served back from cache.
    expect(prs).toHaveLength(101);
    expect(prs[0]?.id).toBe("repo-1:1");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.headers.get("If-None-Match")).toBe('"prs-v1"');
  });
});

describe("probeOpenPrLists", () => {
  const probe = (db: Db, fullNames: readonly string[]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs
          .probeOpenLists(fullNames, "token", "https://api.github.test")
          .pipe(Effect.either);
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

  it("asks for every repo in one request and skips the ones GitHub can't resolve", async () => {
    const db = createDb(":memory:");
    const bodies: Array<{ query: string; variables: Record<string, string> }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responseJson({
        data: {
          r0: {
            pullRequests: { totalCount: 3, nodes: [{ updatedAt: "2026-01-02T00:00:00Z" }] },
          },
          r1: null,
          r2: { pullRequests: { totalCount: 0, nodes: [] } },
        },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
      });
    }) as typeof fetch;

    const result = await probe(db, ["octo/a", "octo/gone", "octo/empty"]);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.variables).toMatchObject({ o0: "octo", n0: "a", n1: "gone", n2: "empty" });
    expect(Either.isRight(result)).toBe(true);
    if (!Either.isRight(result)) return;
    expect([...result.right.entries()]).toEqual([
      ["octo/a", { count: 3, latestUpdatedAt: "2026-01-02T00:00:00Z" }],
      ["octo/empty", { count: 0, latestUpdatedAt: null }],
    ]);
  });

  it("still classifies RATE_LIMITED as a GraphQL rate limit", async () => {
    const db = createDb(":memory:");
    stubFetch(() =>
      responseJson(
        { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        { headers: { "X-RateLimit-Reset": "1800000000" } },
      ),
    );

    const result = await probe(db, ["octo/a"]);

    expect(Either.isLeft(result) && result.left).toBeInstanceOf(GitHubRateLimitError);
    if (Either.isLeft(result) && result.left._tag === "GitHubRateLimitError") {
      expect(result.left.resource).toBe("graphql");
    }
  });
});

describe("listReviewThreads", () => {
  it("follows the cursor and fails rather than reporting no threads for a missing PR", async () => {
    const db = createDb(":memory:");
    const thread = (id: string) => ({
      id,
      isResolved: false,
      comments: { nodes: [{ databaseId: 1 }] },
    });
    const page = (nodes: unknown[], endCursor: string | null) => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
          },
        },
      },
    });
    stubFetch((_call, index) =>
      index === 0
        ? responseJson(page([thread("t1")], "c1"))
        : index === 1
          ? responseJson(page([thread("t2")], null))
          : responseJson({ data: { repository: { pullRequest: null } } }),
    );

    const run = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const github = yield* GitHubGateway;
          return yield* github.reviews
            .listThreads("octo/repo", 1, "token", "https://api.github.test")
            .pipe(Effect.either);
        }).pipe(Effect.provide(gatewayLayer(db))),
      );

    const first = await run();
    expect(Either.isRight(first) && first.right.map((t) => t.nodeId)).toEqual(["t1", "t2"]);
    const missing = await run();
    expect(Either.isLeft(missing) && missing.left).toBeInstanceOf(GitHubNotFoundError);
  });
});

describe("getPrFiles", () => {
  it("collapses the removed+added pair GitHub emits for a type-changed path", async () => {
    const db = createDb(":memory:");
    stubFetch(() =>
      responseJson([
        { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ a" },
        { filename: "AGENTS.md", status: "removed", additions: 0, deletions: 86, patch: "@@ old" },
        { filename: "AGENTS.md", status: "added", additions: 1, deletions: 0, patch: "@@ new" },
      ]),
    );

    const files = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs.files("octo/repo", 1, "token", "https://api.github.test");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(files.map((f) => f.filename)).toEqual(["src/a.ts", "AGENTS.md"]);
    // Last entry wins, matching the diff cache's `onConflictDoUpdate`, so the
    // surviving row is the file's final state.
    expect(files[1]?.status).toBe("added");
    expect(files[1]?.patch).toBe("@@ new");
  });
});

describe("listPrDiffStats", () => {
  it("batches the whole repo into aliased GraphQL requests", async () => {
    const db = createDb(":memory:");
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      bodies.push(body);
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body.variables)) {
        if (!key.startsWith("n")) continue;
        data[`p${key.slice(1)}`] = {
          additions: Number(value),
          deletions: 1,
          changedFiles: 2,
        };
      }
      return responseJson({ data: { repository: data } });
    }) as typeof fetch;

    // 150 PRs: one over the 100-per-request chunk, so the split is exercised.
    const numbers = Array.from({ length: 150 }, (_, i) => i + 1);
    const stats = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs.diffStats(
          "octo/repo",
          numbers,
          "token",
          "https://api.github.test",
        );
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(bodies).toHaveLength(2);
    expect(stats.size).toBe(150);
    expect(stats.get(1)).toEqual({ additions: 1, deletions: 1, changedFiles: 2 });
    expect(stats.get(150)).toEqual({ additions: 150, deletions: 1, changedFiles: 2 });
  });

  it("keeps the PRs GitHub could answer for when others error out", async () => {
    const db = createDb(":memory:");
    stubFetch(() =>
      responseJson({
        // Partially-resolvable aliased query: null for the unanswered alias.
        data: { repository: { p0: { additions: 9, deletions: 3, changedFiles: 1 }, p1: null } },
        errors: [{ message: "Could not resolve to a PullRequest with the number of 2." }],
      }),
    );

    const stats = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs.diffStats("octo/repo", [1, 2], "token", "https://api.github.test");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(stats.size).toBe(1);
    expect(stats.get(1)).toEqual({ additions: 9, deletions: 3, changedFiles: 1 });
    expect(stats.has(2)).toBe(false);
  });

  it("makes no request at all for an empty repo", async () => {
    const db = createDb(":memory:");
    const calls = stubFetch(() => responseJson({}));

    const stats = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        return yield* github.prs.diffStats("octo/repo", [], "token", "https://api.github.test");
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    expect(calls).toHaveLength(0);
    expect(stats.size).toBe(0);
  });
});
