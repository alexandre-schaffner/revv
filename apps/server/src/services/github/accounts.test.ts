import { afterEach, describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../../db/index";
import { account, session, user } from "../../db/schema";
import { GitHubRateLimitError } from "../../domain/errors";
import { DbService } from "../Db";
import { Realtime } from "../Realtime";
import { SecretStore, type TokenPair } from "../SecretStore";
import { GitHubAccounts, GitHubAccountsLive } from "./accounts";
import { AvatarCache } from "./avatars";
import { githubClient } from "./transport";

const HOST = "ghe.example.com";
const HOUR = 60 * 60 * 1000;

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
    setSecret: () => Effect.void,
    getSecret: () => Effect.succeed(null),
    deleteSecret: () => Effect.void,
  });
  return { layer, map };
}

function makeFakeHub() {
  const events: Array<{ accountId: string; msg: ServerEventMessage }> = [];
  const push = (accountId: string, msg: ServerEventMessage) =>
    Effect.sync(() => {
      events.push({ accountId, msg });
    });
  const layer = Layer.succeed(Realtime, {
    toAccount: push,
    toRepo: push,
    toUsers: () => Effect.void,
    toPr: push,
  });
  return { layer, events };
}

const avatarLayer = Layer.succeed(AvatarCache, {
  ensure: () => Effect.succeed({ id: null, changed: false }),
  contents: () => Effect.succeed(new Map<string, string>()),
});

function seedAccount(
  db: Db,
  opts: {
    id: string;
    githubUserId?: string;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    reauthRequiredAt?: Date | null;
    clientId?: string | null;
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
      accountId: opts.githubUserId ?? `gh-${opts.id}`,
      providerId: `github:${HOST}`,
      userId: `user-${opts.id}`,
      githubLogin: `login-${opts.id}`,
      accessTokenExpiresAt: opts.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: opts.refreshTokenExpiresAt ?? null,
      reauthRequiredAt: opts.reauthRequiredAt ?? null,
      clientId: opts.clientId === undefined ? "Iv1testclientid" : opts.clientId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function stubGitHub(opts: { grant?: unknown; userStatus?: number }) {
  const calls = { grant: 0, user: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/login/oauth/access_token")) {
      calls.grant += 1;
      return new Response(JSON.stringify(opts.grant ?? { error: "bad_refresh_token" }));
    }
    if (url.endsWith("/user")) {
      calls.user += 1;
      const status = opts.userStatus ?? 200;
      return new Response(status === 200 ? JSON.stringify({ id: 7, login: "octo" }) : "", {
        status,
      });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function run<A, E>(
  db: Db,
  store: ReturnType<typeof makeFakeStore>,
  hub: ReturnType<typeof makeFakeHub>,
  body: (accounts: GitHubAccounts["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = GitHubAccountsLive.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(DbService, { db }), store.layer, hub.layer, avatarLayer),
    ),
  );
  return Effect.runPromise(Effect.flatMap(GitHubAccounts, body).pipe(Effect.provide(layer)));
}

const reauthAt = (db: Db, id: string) =>
  db
    .select({ reauthRequiredAt: account.reauthRequiredAt })
    .from(account)
    .where(eq(account.id, id))
    .get()?.reauthRequiredAt ?? null;

describe("GitHubAccounts.clientFor", () => {
  it("returns the stored token, addressed at the account's host", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", accessTokenExpiresAt: new Date(Date.now() + HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "tok", refreshToken: "r1" } });
    const calls = stubGitHub({});

    const client = await run(db, store, makeFakeHub(), (a) => a.clientFor("acc"));

    expect(client).toEqual(githubClient(HOST, "tok", "acc"));
    expect(calls.grant).toBe(0);
  });

  it("refreshes a near-expiry token first, with the client ID the token was issued to", async () => {
    const db = createDb(":memory:");
    seedAccount(db, {
      id: "acc",
      clientId: "Iv1testclientid",
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenExpiresAt: new Date(Date.now() + HOUR),
    });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: "r1" } });
    let grantBody: unknown = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      grantBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ access_token: "new", refresh_token: "r2", expires_in: 3600 }),
      );
    }) as unknown as typeof fetch;

    const client = await run(db, store, makeFakeHub(), (a) => a.clientFor("acc"));

    expect(client.token).toBe("new");
    expect(store.map.get("acc")).toEqual({ accessToken: "new", refreshToken: "r2" });
    expect(grantBody).toMatchObject({ client_id: "Iv1testclientid", refresh_token: "r1" });
  });

  it("keeps the stored token when the near-expiry refresh is impossible", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", accessTokenExpiresAt: new Date(Date.now() + 60_000) });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: null } });
    const calls = stubGitHub({});

    const client = await run(db, store, makeFakeHub(), (a) => a.clientFor("acc"));

    expect(client.token).toBe("old");
    expect(calls.grant).toBe(0);
  });
});

describe("GitHubAccounts.observer.unauthorized", () => {
  it("stamps re-auth and broadcasts when neither a refresh nor the token works", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", refreshTokenExpiresAt: new Date(Date.now() + HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: "r1" } });
    const hub = makeFakeHub();
    stubGitHub({ userStatus: 401 });

    const background = await run(db, store, hub, (a) =>
      a.observer
        .unauthorized(githubClient(HOST, "old", "acc"))
        .pipe(Effect.andThen(a.backgroundClient("acc"))),
    );

    expect(reauthAt(db, "acc")).not.toBeNull();
    expect(background).toBeNull();
    expect(hub.events).toContainEqual({
      accountId: "acc",
      msg: { type: "auth:reauth-required", data: { host: HOST, githubLogin: "login-acc" } },
    });
  });

  it("leaves the account alone when the token still answers GET /user", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc" });
    const store = makeFakeStore({ acc: { accessToken: "tok", refreshToken: null } });
    const calls = stubGitHub({ userStatus: 200 });

    await run(db, store, makeFakeHub(), (a) =>
      a.observer.unauthorized(githubClient(HOST, "tok", "acc")),
    );

    expect(calls.user).toBe(1);
    expect(reauthAt(db, "acc")).toBeNull();
  });

  it("leaves the account alone when the probe can't reach a verdict", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", refreshTokenExpiresAt: new Date(Date.now() + HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "tok", refreshToken: "r1" } });
    const calls = stubGitHub({ userStatus: 403 });

    await run(db, store, makeFakeHub(), (a) =>
      a.observer.unauthorized(githubClient(HOST, "tok", "acc")),
    );

    expect(calls.user).toBe(1);
    expect(reauthAt(db, "acc")).toBeNull();
  });

  it("ignores a 401 seen with a token that has since been replaced", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc" });
    const store = makeFakeStore({ acc: { accessToken: "current", refreshToken: "r1" } });
    const calls = stubGitHub({ userStatus: 401 });

    await run(db, store, makeFakeHub(), (a) =>
      a.observer.unauthorized(githubClient(HOST, "stale", "acc")),
    );

    expect(calls).toEqual({ grant: 0, user: 0 });
    expect(reauthAt(db, "acc")).toBeNull();
  });

  it("collapses concurrent reports into one refresh grant", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", refreshTokenExpiresAt: new Date(Date.now() + HOUR) });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: "r1" } });
    const calls = stubGitHub({ grant: { access_token: "new", refresh_token: "r2" } });

    await run(db, store, makeFakeHub(), (a) =>
      Effect.all(
        [
          a.observer.unauthorized(githubClient(HOST, "old", "acc")),
          a.observer.unauthorized(githubClient(HOST, "old", "acc")),
        ],
        { concurrency: "unbounded" },
      ),
    );

    expect(calls.grant).toBe(1);
    expect(store.map.get("acc")).toEqual({ accessToken: "new", refreshToken: "r2" });
    expect(reauthAt(db, "acc")).toBeNull();
  });
});

describe("GitHubAccounts.probeFlagged", () => {
  it("clears a flag whose token works after all", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", reauthRequiredAt: new Date() });
    const store = makeFakeStore({ acc: { accessToken: "tok", refreshToken: null } });
    const hub = makeFakeHub();
    stubGitHub({ userStatus: 200 });

    const [stillFlagged, background] = await run(db, store, hub, (a) =>
      Effect.all([a.probeFlagged("acc"), a.backgroundClient("acc")]),
    );

    expect(stillFlagged).toBe(false);
    expect(background?.token).toBe("tok");
    expect(reauthAt(db, "acc")).toBeNull();
    expect(hub.events.map((e) => e.msg.type)).toEqual(["auth:reauth-cleared"]);
  });

  it("keeps the flag when the token is still refused", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", reauthRequiredAt: new Date() });
    const store = makeFakeStore({ acc: { accessToken: "tok", refreshToken: null } });
    stubGitHub({ userStatus: 401 });

    const stillFlagged = await run(db, store, makeFakeHub(), (a) => a.probeFlagged("acc"));

    expect(stillFlagged).toBe(true);
    expect(reauthAt(db, "acc")).not.toBeNull();
  });
});

describe("GitHubAccounts.backgroundClient", () => {
  it("pauses only the rate-limited budget", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc" });
    const store = makeFakeStore({ acc: { accessToken: "tok", refreshToken: null } });
    stubGitHub({});
    const limit = new GitHubRateLimitError({
      resetAt: new Date(Date.now() + HOUR),
      kind: "primary",
      resource: "graphql",
    });

    const [graphql, core] = await run(db, store, makeFakeHub(), (a) =>
      a.observer
        .rateLimited(githubClient(HOST, "tok", "acc"), limit)
        .pipe(
          Effect.andThen(
            Effect.all([a.backgroundClient("acc", "graphql"), a.backgroundClient("acc", "core")]),
          ),
        ),
    );

    expect(graphql).toBeNull();
    expect(core?.token).toBe("tok");
  });
});

describe("GitHubAccounts.signIn", () => {
  it("linking another GitHub user on a host replaces the row's identity, not just its tokens", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc", githubUserId: "111" });
    const store = makeFakeStore({ acc: { accessToken: "old", refreshToken: null } });
    stubGitHub({ userStatus: 200 }); // GET /user answers id 7, login "octo"

    const result = await run(db, store, makeFakeHub(), (a) =>
      a.signIn({
        host: HOST,
        clientId: "Iv1testclientid",
        tokens: {
          accessToken: "new",
          refreshToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
        },
        linkToUserId: "user-acc",
      }),
    );

    expect(result).toEqual({ userId: "user-acc", sessionToken: null });
    const rows = db.select().from(account).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "acc", accountId: "7", githubLogin: "octo" });
    expect(store.map.get("acc")).toEqual({ accessToken: "new", refreshToken: null });
  });
});

describe("GitHubAccounts.signIn records the issuing client", () => {
  it("stores the client ID, so the refresh grant doesn't depend on the active host", async () => {
    const db = createDb(":memory:");
    stubGitHub({ userStatus: 200 });
    globalThis.fetch = ((orig) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/user/emails")) {
          return new Response(JSON.stringify([{ email: "octo@example.com", primary: true }]));
        }
        return orig(input, init);
      }) as unknown as typeof fetch)(globalThis.fetch);

    await run(db, makeFakeStore(), makeFakeHub(), (a) =>
      a.signIn({
        host: HOST,
        clientId: "Iv1byoclientid",
        tokens: {
          accessToken: "tok",
          refreshToken: "r1",
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
        },
        linkToUserId: null,
      }),
    );

    expect(db.select().from(account).get()).toMatchObject({
      clientId: "Iv1byoclientid",
      scope: null,
    });
  });
});

describe("GitHubAccounts.viewerLogin", () => {
  it("is the account's own login, not the user mirror's", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc" });
    db.update(user).set({ githubLogin: "other-host-login" }).run();

    const login = await run(db, makeFakeStore(), makeFakeHub(), (a) => a.viewerLogin("acc"));

    expect(login).toBe("login-acc");
  });
});

describe("GitHubAccounts.recordIdentity", () => {
  const signed = (sig: string) => `https://${HOST}/avatars/u/7?v=4&token=${sig}`;

  it("treats a re-signed avatar URL as the same image: no write, no push", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc" });
    db.update(account)
      .set({ avatarUrl: signed("a") })
      .where(eq(account.id, "acc"))
      .run();
    const hub = makeFakeHub();

    await run(db, makeFakeStore(), hub, (a) =>
      a.recordIdentity("acc", { login: "login-acc", avatarUrl: signed("b") }),
    );

    expect(hub.events).toEqual([]);
    const row = db.select().from(account).where(eq(account.id, "acc")).get();
    expect(row?.avatarUrl).toBe(signed("a"));
  });

  it("records a moved login on the account row only, and announces it", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc" });
    const hub = makeFakeHub();

    await run(db, makeFakeStore(), hub, (a) =>
      a.recordIdentity("acc", { login: "renamed", avatarUrl: signed("a") }),
    );

    expect(db.select().from(account).where(eq(account.id, "acc")).get()?.githubLogin).toBe(
      "renamed",
    );
    const mirror = db.select().from(user).where(eq(user.id, "user-acc")).get();
    expect(mirror?.githubLogin ?? null).toBeNull();
    expect(mirror?.image ?? null).toBeNull();
    expect(hub.events.map((e) => e.msg.type)).toEqual(["user:updated"]);
  });
});

describe("GitHubAccounts.sessionUser", () => {
  const seedSession = (db: Db, expiresAt: Date) => {
    const now = new Date();
    db.insert(session)
      .values({ id: "s", token: "t", userId: "user-a", expiresAt, createdAt: now, updatedAt: now })
      .run();
  };
  const expiry = (db: Db) => db.select().from(session).get()?.expiresAt.getTime() ?? 0;

  it("extends a session used a day or more after it was last extended", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "a" });
    seedSession(db, new Date(Date.now() + 2 * 24 * HOUR));

    const userId = await run(db, makeFakeStore(), makeFakeHub(), (a) => a.sessionUser("t"));

    expect(userId).toBe("user-a");
    expect(expiry(db)).toBeGreaterThan(Date.now() + 29 * 24 * HOUR);
  });

  it("answers null for an expired session", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "a" });
    seedSession(db, new Date(Date.now() - 1000));

    const userId = await run(db, makeFakeStore(), makeFakeHub(), (a) => a.sessionUser("t"));

    expect(userId).toBeNull();
  });
});

describe("GitHubAccounts.migrateLegacyTokens", () => {
  it("moves plaintext tokens into the store, nulls the columns, and is idempotent", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc-1" });
    seedAccount(db, { id: "acc-2" });
    db.update(account)
      .set({ accessToken: "gho_plain", refreshToken: "ghr_plain" })
      .where(eq(account.id, "acc-1"))
      .run();
    const store = makeFakeStore();

    const [migrated, again] = await run(db, store, makeFakeHub(), (a) =>
      Effect.all([a.migrateLegacyTokens, a.migrateLegacyTokens]),
    );

    expect([migrated, again]).toEqual([1, 0]);
    expect(store.map.get("acc-1")).toEqual({ accessToken: "gho_plain", refreshToken: "ghr_plain" });
    expect(store.map.has("acc-2")).toBe(false);
    expect(db.select().from(account).where(eq(account.id, "acc-1")).get()).toMatchObject({
      accessToken: null,
      refreshToken: null,
    });
  });
});

describe("GitHubAccounts.switchTo", () => {
  it("mints a session only for a user signed in on this machine", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "a" });
    seedAccount(db, { id: "b" });
    const now = new Date();
    db.insert(session)
      .values({
        id: "s-a",
        token: "token-a",
        userId: "user-a",
        expiresAt: new Date(now.getTime() + HOUR),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const [toA, toB] = await run(db, makeFakeStore(), makeFakeHub(), (a) =>
      Effect.all([a.switchTo("user-a"), a.switchTo("user-b")]),
    );

    expect(typeof toA).toBe("string");
    expect(toB).toBeNull();
  });
});
