import { afterEach, describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, user } from "../db/schema";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";
import { SecretStore, type TokenPair } from "./SecretStore";
import { TokenProvider, TokenProviderLive } from "./TokenProvider";

// ── Fakes ──────────────────────────────────────────────────────────────────

function makeFakeStore(initial?: Record<string, TokenPair>) {
  const map = new Map<string, TokenPair>(Object.entries(initial ?? {}));
  const layer = Layer.succeed(SecretStore, {
    setTokens: (id: string, tokens: TokenPair) =>
      Effect.sync(() => {
        map.set(id, tokens);
      }),
    getTokens: (id: string) => Effect.sync(() => map.get(id) ?? null),
    deleteTokens: (id: string) =>
      Effect.sync(() => {
        map.delete(id);
      }),
  });
  return { layer, map };
}

function makeFakeHub() {
  const events: Array<{ accountId: string; msg: ServerEventMessage }> = [];
  const layer = Layer.succeed(Broadcaster, {
    register: () => Effect.succeed(() => undefined),
    broadcastToAccount: (accountId: string, msg: ServerEventMessage) =>
      Effect.sync(() => {
        events.push({ accountId, msg });
      }),
    broadcastAll: (msg: ServerEventMessage) =>
      Effect.sync(() => {
        events.push({ accountId: "*", msg });
      }),
  });
  return { layer, events };
}

function seedAccount(
  db: Db,
  opts: {
    id: string;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    reauthRequiredAt?: Date | null;
  },
) {
  const now = new Date();
  db.insert(user)
    .values({
      id: `user-${opts.id}`,
      name: "Test",
      email: `${opts.id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(account)
    .values({
      id: opts.id,
      accountId: `gh-${opts.id}`,
      providerId: "github:github.com",
      userId: `user-${opts.id}`,
      accessTokenExpiresAt: opts.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: opts.refreshTokenExpiresAt ?? null,
      reauthRequiredAt: opts.reauthRequiredAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function buildLayer(
  db: Db,
  store: ReturnType<typeof makeFakeStore>,
  hub: ReturnType<typeof makeFakeHub>,
) {
  return TokenProviderLive.pipe(
    Layer.provide(Layer.succeed(DbService, { db })),
    Layer.provide(store.layer),
    Layer.provide(hub.layer),
  );
}

// Replace global fetch with a recording stub returning a fixed JSON payload.
function stubFetch(payload: unknown, status = 200) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const HOUR = 60 * 60 * 1000;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("TokenProvider.refreshAccountToken", () => {
  it("rotates the access + refresh token, clears reauth, and broadcasts cleared", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", refreshTokenExpiresAt: new Date(Date.now() + HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: "r1" } });
    const hub = makeFakeHub();
    const fetchStub = stubFetch({
      access_token: "new",
      refresh_token: "r2",
      expires_in: 3600,
      refresh_token_expires_in: 7200,
    });

    const token = await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        return yield* p.refreshAccountToken("acc");
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    expect(token).toBe("new");
    expect(fetchStub.calls()).toBe(1);
    expect(store.map.get("acc")).toEqual({ accessToken: "new", refreshToken: "r2" });

    const row = db
      .select({ reauthRequiredAt: account.reauthRequiredAt })
      .from(account)
      .where(eq(account.id, "acc"))
      .get();
    expect(row?.reauthRequiredAt).toBeNull();
    expect(
      hub.events.some((e) => e.msg.type === "auth:reauth-cleared" && e.accountId === "acc"),
    ).toBe(true);
  });

  it("fails without issuing a grant when no refresh token is stored", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc" });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: null } });
    const hub = makeFakeHub();
    const fetchStub = stubFetch({ access_token: "new" });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        return yield* p.refreshAccountToken("acc").pipe(Effect.either);
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    expect(Either.isLeft(result)).toBe(true);
    expect(fetchStub.calls()).toBe(0);
  });

  it("fails without issuing a grant when the refresh token is expired", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", refreshTokenExpiresAt: new Date(Date.now() - HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: "r1" } });
    const hub = makeFakeHub();
    const fetchStub = stubFetch({ access_token: "new" });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        return yield* p.refreshAccountToken("acc").pipe(Effect.either);
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    expect(Either.isLeft(result)).toBe(true);
    expect(fetchStub.calls()).toBe(0);
  });

  it("fails and leaves the stored token untouched when GitHub rejects the grant", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", refreshTokenExpiresAt: new Date(Date.now() + HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: "r1" } });
    const hub = makeFakeHub();
    stubFetch({ error: "bad_refresh_token" });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        return yield* p.refreshAccountToken("acc").pipe(Effect.either);
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    expect(Either.isLeft(result)).toBe(true);
    expect(store.map.get("acc")).toEqual({ accessToken: "old", refreshToken: "r1" });
  });

  it("collapses concurrent refreshes of the same account into a single grant", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", refreshTokenExpiresAt: new Date(Date.now() + HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: "r1" } });
    const hub = makeFakeHub();
    const fetchStub = stubFetch({ access_token: "new", refresh_token: "r2", expires_in: 3600 });

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        return yield* Effect.all([p.refreshAccountToken("acc"), p.refreshAccountToken("acc")], {
          concurrency: "unbounded",
        });
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    expect(results).toEqual(["new", "new"]);
    expect(fetchStub.calls()).toBe(1);
  });
});

describe("TokenProvider.markReauthRequired", () => {
  it("stamps reauthRequiredAt and broadcasts auth:reauth-required", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc" });
    const store = makeFakeStore();
    const hub = makeFakeHub();

    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        yield* p.markReauthRequired("acc");
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    const row = db
      .select({ reauthRequiredAt: account.reauthRequiredAt })
      .from(account)
      .where(eq(account.id, "acc"))
      .get();
    expect(row?.reauthRequiredAt).not.toBeNull();

    const evt = hub.events.find((e) => e.msg.type === "auth:reauth-required");
    expect(evt?.accountId).toBe("acc");
    expect(evt?.msg.type === "auth:reauth-required" && evt.msg.data.host).toBe("github.com");
  });
});

describe("TokenProvider.clearReauthRequired", () => {
  it("clears reauthRequiredAt and broadcasts auth:reauth-cleared", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", reauthRequiredAt: new Date(Date.now() - HOUR) });
    const store = makeFakeStore();
    const hub = makeFakeHub();

    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        yield* p.clearReauthRequired("acc");
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    const row = db
      .select({ reauthRequiredAt: account.reauthRequiredAt })
      .from(account)
      .where(eq(account.id, "acc"))
      .get();
    expect(row?.reauthRequiredAt).toBeNull();

    const evt = hub.events.find((e) => e.msg.type === "auth:reauth-cleared");
    expect(evt?.accountId).toBe("acc");
    expect(evt?.msg.type === "auth:reauth-cleared" && evt.msg.data.host).toBe("github.com");
  });
});

describe("TokenProvider.storeAccountTokens", () => {
  it("stores token bytes and clears a stale persisted reauth gate", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", reauthRequiredAt: new Date(Date.now() - HOUR) });
    const store = makeFakeStore();
    const hub = makeFakeHub();

    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        yield* p.storeAccountTokens("acc", "github.com", {
          accessToken: "new",
          refreshToken: null,
        });
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    expect(store.map.get("acc")).toEqual({ accessToken: "new", refreshToken: null });
    const row = db
      .select({ reauthRequiredAt: account.reauthRequiredAt })
      .from(account)
      .where(eq(account.id, "acc"))
      .get();
    expect(row?.reauthRequiredAt).toBeNull();
    expect(hub.events.some((e) => e.msg.type === "auth:reauth-cleared")).toBe(true);
  });
});

describe("TokenProvider.getTokenByAccountId", () => {
  it("returns the stored token unchanged when it is not near expiry", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", accessTokenExpiresAt: new Date(Date.now() + HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "current", refreshToken: "r1" } });
    const hub = makeFakeHub();
    const fetchStub = stubFetch({ access_token: "new" });

    const token = await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        return yield* p.getTokenByAccountId("acc");
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    expect(token).toBe("current");
    expect(fetchStub.calls()).toBe(0);
  });

  it("transparently refreshes a near-expiry token before returning it", async () => {
    const db = createDb(":memory:");
    // Expires in 1 minute — inside the 5-minute refresh skew.
    seedAccount(db, {
      id: "acc",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + HOUR),
    });
    const store = makeFakeStore({ acc: { accessToken: "current", refreshToken: "r1" } });
    const hub = makeFakeHub();
    const fetchStub = stubFetch({ access_token: "new", refresh_token: "r2", expires_in: 3600 });

    const token = await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* TokenProvider;
        return yield* p.getTokenByAccountId("acc");
      }).pipe(Effect.provide(buildLayer(db, store, hub))),
    );

    expect(token).toBe("new");
    expect(fetchStub.calls()).toBe(1);
    expect(store.map.get("acc")).toEqual({ accessToken: "new", refreshToken: "r2" });
  });
});
