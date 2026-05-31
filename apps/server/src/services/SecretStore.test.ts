import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, user } from "../db/schema";
import { DbService } from "./Db";
import {
  deserialize,
  migrateLegacyTokens,
  SecretStore,
  serialize,
  type TokenPair,
} from "./SecretStore";

/** In-memory stand-in for the OS secure store, exposing its backing map. */
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

function seedAccount(
  db: Db,
  opts: { id: string; accessToken: string | null; refreshToken: string | null },
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
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("SecretStore serialize/deserialize", () => {
  it("round-trips a full token pair", () => {
    const pair: TokenPair = { accessToken: "gho_abc", refreshToken: "ghr_def" };
    expect(deserialize(serialize(pair))).toEqual(pair);
  });

  it("normalizes a missing refresh token to null", () => {
    expect(deserialize(serialize({ accessToken: "a", refreshToken: null }))).toEqual({
      accessToken: "a",
      refreshToken: null,
    });
  });

  it("tolerates a legacy raw-string access token (non-JSON)", () => {
    expect(deserialize("gho_legacy")).toEqual({ accessToken: "gho_legacy", refreshToken: null });
  });
});

describe("migrateLegacyTokens", () => {
  it("moves plaintext tokens into the store, nulls the columns, and is idempotent", async () => {
    const db = createDb(":memory:");
    seedAccount(db, { id: "acc-1", accessToken: "gho_plain", refreshToken: "ghr_plain" });
    // Already-migrated row (null columns) must be skipped.
    seedAccount(db, { id: "acc-2", accessToken: null, refreshToken: null });

    const { layer, map } = makeFakeStore();
    const provided = Layer.merge(Layer.succeed(DbService, { db }), layer);

    const migrated = await Effect.runPromise(migrateLegacyTokens.pipe(Effect.provide(provided)));
    expect(migrated).toBe(1);
    expect(map.get("acc-1")).toEqual({ accessToken: "gho_plain", refreshToken: "ghr_plain" });
    expect(map.has("acc-2")).toBe(false);

    const row = db
      .select({ accessToken: account.accessToken, refreshToken: account.refreshToken })
      .from(account)
      .where(eq(account.id, "acc-1"))
      .get();
    expect(row?.accessToken).toBeNull();
    expect(row?.refreshToken).toBeNull();

    // Second boot: columns are already null, nothing left to migrate.
    const again = await Effect.runPromise(migrateLegacyTokens.pipe(Effect.provide(provided)));
    expect(again).toBe(0);
  });
});
