import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb } from "../db/index";
import { account, pullRequests, repositories, user } from "../db/schema";
import { Broadcaster, BroadcasterLive } from "./Broadcaster";
import { CacheServiceLive } from "./Cache";
import { DbService } from "./Db";
import { DiffCacheServiceLive } from "./DiffCache";
import { GitHubAccountsLive } from "./github/accounts";
import { AvatarCacheLive } from "./github/avatars";
import { type GitHubEtagCache, GitHubEtagCacheLive } from "./github/etag-cache";
import { GitHubGatewayLive } from "./github/gateway";
import { PrContextService, PrContextServiceLive } from "./PrContext";
import { PrConversationService, PrConversationServiceLive } from "./PrConversation";
import { PullRequestServiceLive } from "./PullRequest";
import { RealtimeLive } from "./Realtime";
import { RepositoryServiceLive } from "./Repository";
import { SecretStore } from "./SecretStore";

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
  const realtime = RealtimeLive.pipe(Layer.provideMerge(BroadcasterLive), Layer.provide(dbLayer));
  const avatars = AvatarCacheLive.pipe(Layer.provide(dbLayer));
  const accounts = GitHubAccountsLive.pipe(
    Layer.provide(Layer.mergeAll(dbLayer, secrets, realtime, avatars)),
  );
  const gateway = GitHubGatewayLive.pipe(
    Layer.provide(Layer.mergeAll(GitHubEtagCacheLive.pipe(Layer.provide(dbLayer)), accounts)),
  );
  const base = Layer.mergeAll(
    dbLayer,
    secrets,
    realtime,
    accounts,
    gateway,
    CacheServiceLive,
    PullRequestServiceLive,
    RepositoryServiceLive,
    DiffCacheServiceLive.pipe(Layer.provide(Layer.mergeAll(dbLayer, gateway, realtime))),
    avatars,
  );
  const context = PrContextServiceLive.pipe(Layer.provide(base));
  const layer = PrConversationServiceLive.pipe(Layer.provideMerge(Layer.merge(base, context)));
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      PrConversationService | PrContextService | Broadcaster | DbService | GitHubEtagCache
    >,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layer),
        Effect.provide(dbLayer),
        Effect.provide(GitHubEtagCacheLive.pipe(Layer.provide(dbLayer))),
      ),
    );
  return { db, tokenReads, run };
}

describe("PrConversationService", () => {
  it("reads the snapshot without the owning account's token", async () => {
    const { db, tokenReads, run } = fixture();
    try {
      const snapshot = await run(Effect.flatMap(PrConversationService, (s) => s.cached("b-pr")));
      expect(snapshot).toBeNull();
      expect(tokenReads).toEqual([]);
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
          const running = yield* s.checkDetails("b-pr", 123);
          expect(running.completed).toBe(false);
          completed = true;
          const final = yield* s.checkDetails("b-pr", 123);
          expect(final.completed).toBe(true);
          expect(final.summary).toBe("Final output");
          yield* s.checkDetails("b-pr", 123);
          expect(checkReads).toBe(2);
        }),
      );
    } finally {
      db.$client.close();
    }
  });

  it("announces a write made elsewhere to its account's user even when GitHub can't be re-read", async () => {
    const { db, run } = fixture();
    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError("network down");
      },
      { preconnect: realFetch.preconnect },
    );
    const writer = (sent: unknown[]) => ({
      send: (event: unknown) => sent.push(event) > 0,
      isClosed: () => false,
    });
    const owner: unknown[] = [];
    const other: unknown[] = [];
    try {
      const result = await run(
        Effect.gen(function* () {
          const broadcaster = yield* Broadcaster;
          yield* broadcaster.register("b", writer(owner));
          yield* broadcaster.register("a", writer(other));
          const ctx = yield* Effect.flatMap(PrContextService, (c) => c.forPr("b-pr"));
          return yield* Effect.flatMap(PrConversationService, (s) => s.afterWrite(ctx));
        }),
      );
      expect(result).toEqual({ conversation: null });
      expect(owner).toEqual([
        { type: "pr:conversation-updated", data: { prId: "b-pr", fetchedAt: null } },
      ]);
      expect(other).toEqual([]);
    } finally {
      db.$client.close();
    }
  });
});
