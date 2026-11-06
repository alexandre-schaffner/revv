import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, user } from "../db/schema";
import { DbService } from "./Db";
import {
  deserialize,
  fallbackMapForWrite,
  migrateLegacyTokens,
  SecretStore,
  serialize,
  type TokenPair,
} from "./SecretStore";

function makeFakeStore(initial?: Record<string, TokenPair>) {
  const map = new Map<string, TokenPair>(Object.entries(initial ?? {}));
  const secrets = new Map<string, string>();
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
    setSecret: (key: string, value: string) =>
      Effect.sync(() => {
        secrets.set(key, value);
      }),
    getSecret: (key: string) => Effect.sync(() => secrets.get(key) ?? null),
    deleteSecret: (key: string) =>
      Effect.sync(() => {
        secrets.delete(key);
      }),
  });
  return { layer, map, secrets };
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

describe("encrypted-file fallback", () => {
  it("moves an unreadable store aside instead of overwriting it on the next write", () => {
    const dir = mkdtempSync(join(tmpdir(), "revv-secret-store-"));
    const path = join(dir, "secret-store.enc");
    const unreadable = Buffer.from("not ciphertext");
    writeFileSync(path, unreadable);

    expect(fallbackMapForWrite(path)).toEqual({});

    expect(existsSync(path)).toBe(false);
    const aside = readdirSync(dir).filter((f) => f.startsWith("secret-store.enc.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] ?? ""))).toEqual(unreadable);
  });

  it("starts empty when there is no store yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "revv-secret-store-"));
    expect(fallbackMapForWrite(join(dir, "secret-store.enc"))).toEqual({});
    expect(readdirSync(dir)).toEqual([]);
  });
});
