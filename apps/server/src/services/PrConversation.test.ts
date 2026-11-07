import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_USER_SETTINGS } from "@revv/shared";
import { type Context, Effect, Layer, Stream } from "effect";
import { createDb } from "../db/index";
import { account, pullRequests, repositories, user } from "../db/schema";
import { NotFoundError } from "../domain/errors";
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
import { SettingsService } from "./Settings";

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
  const settings = Layer.succeed(SettingsService, {
    getSettings: () => Effect.succeed(DEFAULT_USER_SETTINGS),
    githubHost: () => Effect.succeed("github.com"),
    watch: () => Stream.empty,
  } as unknown as Context.Service.Shape<typeof SettingsService>);
  const accounts = GitHubAccountsLive.pipe(
    Layer.provide(Layer.mergeAll(dbLayer, secrets, realtime, settings)),
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
    AvatarCacheLive.pipe(Layer.provide(dbLayer)),
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
            s.cached("b-pr", "a-account").pipe(Effect.result),
            s.load("b-pr", "a-account").pipe(Effect.result),
            s.checks("b-pr", "a-account").pipe(Effect.result),
            s.checkDetails("b-pr", "a-account", 123).pipe(Effect.result),
            s.labelOptions("b-pr", "a-account").pipe(Effect.result),
            s.assigneeOptions("b-pr", "a-account", "").pipe(Effect.result),
            s.reviewerOptions("b-pr", "a-account", "").pipe(Effect.result),
            s
              .write("b-pr", "a-account", { kind: "post_comment", body: "unauthorized" })
              .pipe(Effect.result),
          ]);
        }),
      );
      expect(results).toHaveLength(8);
      for (const result of results) {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(NotFoundError);
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
        Effect.flatMap(PrConversationService, (s) => s.cached("b-pr", "b-account")),
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
          const running = yield* s.checkDetails("b-pr", "b-account", 123);
          expect(running.completed).toBe(false);
          completed = true;
          const final = yield* s.checkDetails("b-pr", "b-account", 123);
          expect(final.completed).toBe(true);
          expect(final.summary).toBe("Final output");
          yield* s.checkDetails("b-pr", "b-account", 123);
          expect(checkReads).toBe(2);
        }),
      );
    } finally {
      db.$client.close();
    }
  });

  it("announces a write made elsewhere to its account even when GitHub can't be re-read", async () => {
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
          yield* broadcaster.register("b-account", writer(owner));
          yield* broadcaster.register("a-account", writer(other));
          const ctx = yield* Effect.flatMap(PrContextService, (c) => c.forPr("b-pr", "b-account"));
          return yield* Effect.flatMap(PrConversationService, (s) =>
            s.afterWrite(ctx, "b-account"),
          );
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
