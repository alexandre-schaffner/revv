import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Either, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { GitHubRateLimitError } from "../domain/errors";
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

  it("replays cached open PRs on 304 only when the cached set fit on one page", async () => {
    const db = createDb(":memory:");
    const firstPage = Array.from({ length: 100 }, (_, i) => rawPr(i + 1));
    const calls = stubFetch((_call, index) => {
      if (index === 0) {
        return responseJson(firstPage, { headers: { ETag: '"prs-v1"' } });
      }
      if (index === 1) {
        return new Response(null, { status: 304 });
      }
      return responseJson([rawPr(101)], { headers: { ETag: '"prs-v2"' } });
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

    expect(prs).toHaveLength(1);
    expect(prs[0]?.externalId).toBe(101);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.headers.get("If-None-Match")).toBe('"prs-v1"');
    expect(calls[2]?.headers.get("If-None-Match")).toBeNull();
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
