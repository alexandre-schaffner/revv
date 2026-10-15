import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb } from "../db/index";
import { account, pullRequests, repositories, user } from "../db/schema";
import { NotFoundError } from "../domain/errors";
import { BroadcasterLive } from "./Broadcaster";
import { CacheServiceLive } from "./Cache";
import { DbService } from "./Db";
import { DiffCacheServiceLive } from "./DiffCache";
import { GitHubGatewayLive } from "./GitHub";
import { type GitHubEtagCache, GitHubEtagCacheLive } from "./GitHubEtagCache";
import { PrContextServiceLive } from "./PrContext";
import { PrConversationService, PrConversationServiceLive } from "./PrConversation";
import { PullRequestServiceLive } from "./PullRequest";
import { RemoteUserServiceLive } from "./RemoteUser";
import { RepositoryServiceLive } from "./Repository";
import { SecretStore } from "./SecretStore";
import { TokenProviderLive } from "./TokenProvider";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fixture() {
  const db = createDb(":memory:");
  const now = new Date();
  for (const id of ["a", "b"]) {
    db.insert(user)
      .values({ id, name: id, email: `${id}@example.com`, createdAt: now, updatedAt: now })
      .run();
    db.insert(account)
      .values({
        id: `${id}-account`,
        accountId: id,
        providerId: "github:github.com",
        userId: id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  db.insert(repositories)
    .values({
      id: "b-repo",
      owner: "b",
      name: "private",
      fullName: "b/private",
      accountId: "b-account",
      addedAt: now.toISOString(),
    })
    .run();
  db.insert(pullRequests)
    .values({
      id: "b-pr",
      repositoryId: "b-repo",
      externalId: 1,
      title: "private PR",
      authorLogin: "b",
      sourceBranch: "feature",
      targetBranch: "main",
      url: "https://github.com/b/private/pull/1",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      fetchedAt: now.toISOString(),
    })
    .run();

  const tokenReads: string[] = [];
  const secrets = Layer.succeed(SecretStore, {
    getTokens: (id) =>
      Effect.sync(() => {
        tokenReads.push(id);
        return { accessToken: "synthetic-test-token", refreshToken: null };
      }),
    setTokens: () => Effect.void,
    deleteTokens: () => Effect.void,
    getSecret: () => Effect.succeed(null),
    setSecret: () => Effect.void,
    deleteSecret: () => Effect.void,
  });
  const dbLayer = Layer.succeed(DbService, { db });
  const base = Layer.mergeAll(
    dbLayer,
    secrets,
    BroadcasterLive,
    CacheServiceLive,
    GitHubGatewayLive,
    PullRequestServiceLive,
    RepositoryServiceLive,
    DiffCacheServiceLive,
    RemoteUserServiceLive.pipe(Layer.provide(dbLayer)),
  );
  const context = PrContextServiceLive.pipe(
    Layer.provide(Layer.merge(base, TokenProviderLive.pipe(Layer.provide(base)))),
  );
  const layer = PrConversationServiceLive.pipe(Layer.provide(Layer.merge(base, context)));
  const run = <A, E>(
    effect: Effect.Effect<A, E, PrConversationService | DbService | GitHubEtagCache>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layer),
        Effect.provide(dbLayer),
        Effect.provide(GitHubEtagCacheLive),
      ),
    );
  return { db, tokenReads, run };
}

describe("conversation account isolation", () => {
  it("rejects every read and write for another account before accessing credentials or GitHub", async () => {
    const { db, tokenReads, run } = fixture();
    let githubCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        githubCalls++;
        throw new Error("Unexpected GitHub call");
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const results = await run(
        Effect.gen(function* () {
          const s = yield* PrConversationService;
          return yield* Effect.all([
            s.cached("b-pr", "a", "a-account").pipe(Effect.either),
            s.load("b-pr", "a", "a-account").pipe(Effect.either),
            s.checks("b-pr", "a", "a-account").pipe(Effect.either),
            s.checkDetails("b-pr", "a", "a-account", 123).pipe(Effect.either),
            s.labelOptions("b-pr", "a", "a-account").pipe(Effect.either),
            s.assigneeOptions("b-pr", "a", "a-account", "").pipe(Effect.either),
            s.reviewerOptions("b-pr", "a", "a-account", "").pipe(Effect.either),
            s
              .write("b-pr", "a", "a-account", { kind: "post_comment", body: "unauthorized" })
              .pipe(Effect.either),
          ]);
        }),
      );
      expect(results).toHaveLength(8);
      for (const result of results) {
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") expect(result.left).toBeInstanceOf(NotFoundError);
      }
      expect(tokenReads).toEqual([]);
      expect(githubCalls).toBe(0);
    } finally {
      db.$client.close();
    }
  });

  it("still allows the owning account to read its snapshot", async () => {
    const { db, tokenReads, run } = fixture();
    try {
      const snapshot = await run(
        Effect.flatMap(PrConversationService, (s) => s.cached("b-pr", "b", "b-account")),
      );
      expect(snapshot).toBeNull();
      expect(tokenReads).toEqual(["b-account"]);
    } finally {
      db.$client.close();
    }
  });

  it("re-reads unfinished third-party details and caches them only after completion", async () => {
    const { db, run } = fixture();
    let completed = false;
    let checkReads = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        if (String(input).includes("/annotations")) return new Response("[]");
        checkReads++;
        return Response.json({
          status: completed ? "completed" : "in_progress",
          app: { slug: "third-party-ci" },
          output: { title: "CI", summary: completed ? "Final output" : "Starting" },
        });
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      await run(
        Effect.gen(function* () {
          const s = yield* PrConversationService;
          const running = yield* s.checkDetails("b-pr", "b", "b-account", 123);
          expect(running.completed).toBe(false);
          completed = true;
          const final = yield* s.checkDetails("b-pr", "b", "b-account", 123);
          expect(final.completed).toBe(true);
          expect(final.summary).toBe("Final output");
          yield* s.checkDetails("b-pr", "b", "b-account", 123);
          expect(checkReads).toBe(2);
        }),
      );
    } finally {
      db.$client.close();
    }
  });
});
