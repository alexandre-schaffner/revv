import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Either, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { GitHubApiError, GitHubRateLimitError } from "../domain/errors";
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

  // `listOpen` replays a cached 304 unconditionally, including a multi-page
  // cached set. That is safe *because of the sort*: `?sort=updated&direction=desc`
  // moves any changed PR onto page 1, so page 1's ETag — the one we send
  // If-None-Match against — moves whenever anything anywhere in the list moves.
  // A 304 there genuinely means "no page changed".
  //
  // Contrast `listComments` below, which does force a refetch on a full page.
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
        yield* github.prs.listOpen("octo/repo", "repo-1", "token", "https://api.github.test");
        return yield* github.prs.listOpen(
          "octo/repo",
          "repo-1",
          "token",
          "https://api.github.test",
        );
      }).pipe(Effect.provide(gatewayLayer(db))),
    );

    // Both pages of the first fetch, served back from cache.
    expect(prs).toHaveLength(101);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.headers.get("If-None-Match")).toBe('"prs-v1"');
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
    const calls = stubFetch(() => responseJson([rawPr(1)], { headers: { ETag: '"prs-v1"' } }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubGateway;
        yield* github.prs.listOpen("octo/repo", "repo-1", "token-a", "https://api.github.test");
        yield* github.prs.listOpen("octo/repo", "repo-1", "token-a", "https://api.github.example");
        yield* github.prs.listOpen("octo/repo", "repo-1", "token-b", "https://api.github.test");
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
      index < 1
        ? new Response("boom", { status: 503 })
        : responseJson([rawPr(1)], { headers: { ETag: '"prs-v1"' } }),
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
