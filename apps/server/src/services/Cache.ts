import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Context, Effect, type Exit, Layer } from "effect";
import { daysBefore, type RetentionPolicy } from "../db/retention";
import { kvCache } from "../db/schema/index";
import type { DbError } from "../domain/errors";
import { dbTry } from "../effects/db-try";
import { DbService } from "./Db";

/**
 * How long an entry that never goes stale is kept after it was written. Its
 * key pins content (a head SHA, a diff), so once that content is this old
 * nothing asks for it again; an entry that is asked for is simply recomputed.
 */
const IMMUTABLE_RETENTION_DAYS = 30;

/** Entries past their expiry, and entries that never expire once they are old. */
export const kvCacheRetention: RetentionPolicy = {
  table: "kv_cache",
  sweep: (db, now) =>
    db
      .delete(kvCache)
      .where(
        or(
          lt(kvCache.expiresAt, now.toISOString()),
          and(
            isNull(kvCache.expiresAt),
            lt(kvCache.fetchedAt, daysBefore(now, IMMUTABLE_RETENTION_DAYS)),
          ),
        ),
      )
      .returning({ key: kvCache.key })
      .all().length,
};

/** Entries held in memory in front of SQLite; the least recently used go first. */
const MEMORY_ENTRIES = 2_000;

/**
 * Keys that never go stale (anything containing `headSha` / `baseSha` / `ref`)
 * should set `immutable: true`: no expiry, kept until retention ages them out.
 * `immutable: true` overrides `ttlMs`; passing neither is treated as immutable.
 */
export interface CacheSetOptions {
  readonly ttlMs?: number;
  readonly immutable?: boolean;
}

export interface CacheStatsSnapshot {
  readonly hits: number;
  readonly misses: number;
  readonly inflightDedups: number;
  readonly namespaces: ReadonlyArray<{ ns: string; entries: number }>;
}

/**
 * For **small metadata blobs** (the GitHub repos list, the authenticated-user
 * payload, TTL-scoped lookups). Large bodies (diffs, file contents, AI
 * explanations) belong in their purpose-built tables.
 *
 * Stats are in-memory only and reset on process restart.
 */
export class CacheService extends Context.Service<
  CacheService,
  {
    readonly get: <T>(ns: string, key: string) => Effect.Effect<T | null, DbError>;
    readonly set: <T>(
      ns: string,
      key: string,
      value: T,
      opts?: CacheSetOptions,
    ) => Effect.Effect<void, DbError>;
    readonly invalidate: (ns: string, key: string) => Effect.Effect<void, DbError>;
    readonly getOrFetch: <T, E, R>(
      ns: string,
      key: string,
      fetcher: () => Effect.Effect<T, E, R>,
      opts?: CacheSetOptions,
    ) => Effect.Effect<T, E | DbError, R>;
    readonly stats: () => Effect.Effect<CacheStatsSnapshot, DbError>;
  }
>()("CacheService") {}

export const CacheServiceLive = Layer.effect(
  CacheService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    type MemEntry = { value: unknown; expiresAt: number | null };
    const memory = new Map<string, MemEntry>();
    const cacheKey = (ns: string, key: string) => `${ns}\0${key}`;

    const inflight = new Map<string, Promise<unknown>>();

    let hits = 0;
    let misses = 0;
    let inflightDedups = 0;

    const isExpired = (expiresAt: number | null): boolean =>
      expiresAt !== null && Date.now() > expiresAt;

    const parseIso = (s: string | null): number | null => {
      if (s === null) return null;
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    };

    const readMemory = (ns: string, key: string): unknown | undefined => {
      const k = cacheKey(ns, key);
      const entry = memory.get(k);
      if (!entry) return undefined;
      memory.delete(k);
      if (isExpired(entry.expiresAt)) return undefined;
      memory.set(k, entry);
      return entry.value;
    };

    const writeMemory = (
      ns: string,
      key: string,
      value: unknown,
      expiresAt: number | null,
    ): void => {
      const k = cacheKey(ns, key);
      memory.delete(k);
      memory.set(k, { value, expiresAt });
      // A Map iterates in insertion order, and a read re-inserts: the first key is the coldest.
      while (memory.size > MEMORY_ENTRIES) {
        const coldest = memory.keys().next().value;
        if (coldest === undefined) break;
        memory.delete(coldest);
      }
    };

    const get = <T>(ns: string, key: string) =>
      Effect.gen(function* () {
        const mem = readMemory(ns, key);
        if (mem !== undefined) {
          hits++;
          return mem as T;
        }

        const row = yield* dbTry(`cache.get(${ns}, ${key})`, () =>
          db
            .select({
              valueJson: kvCache.valueJson,
              expiresAt: kvCache.expiresAt,
            })
            .from(kvCache)
            .where(and(eq(kvCache.ns, ns), eq(kvCache.key, key)))
            .get(),
        );

        if (!row) {
          misses++;
          return null;
        }

        const expiresAt = parseIso(row.expiresAt);
        if (isExpired(expiresAt)) {
          yield* dbTry(`cache.get expired delete(${ns}, ${key})`, () =>
            db
              .delete(kvCache)
              .where(and(eq(kvCache.ns, ns), eq(kvCache.key, key)))
              .run(),
          );
          misses++;
          return null;
        }

        let parsed: T;
        try {
          parsed = JSON.parse(row.valueJson) as T;
        } catch {
          misses++;
          return null;
        }

        writeMemory(ns, key, parsed, expiresAt);
        hits++;
        return parsed;
      });

    const set = <T>(ns: string, key: string, value: T, opts: CacheSetOptions = {}) =>
      Effect.gen(function* () {
        const now = Date.now();
        const expiresAt = opts.immutable
          ? null
          : typeof opts.ttlMs === "number"
            ? new Date(now + opts.ttlMs).toISOString()
            : null;
        const expiresAtMs = expiresAt ? Date.parse(expiresAt) : null;
        const valueJson = JSON.stringify(value);
        const fetchedAt = new Date(now).toISOString();

        yield* dbTry(`cache.set(${ns}, ${key})`, () =>
          db
            .insert(kvCache)
            .values({
              ns,
              key,
              valueJson,
              fetchedAt,
              expiresAt,
            })
            .onConflictDoUpdate({
              target: [kvCache.ns, kvCache.key],
              set: { valueJson, fetchedAt, expiresAt },
            })
            .run(),
        );

        writeMemory(ns, key, value, expiresAtMs);
      });

    const invalidate = (ns: string, key: string) =>
      Effect.gen(function* () {
        yield* dbTry(`cache.invalidate(${ns}, ${key})`, () =>
          db
            .delete(kvCache)
            .where(and(eq(kvCache.ns, ns), eq(kvCache.key, key)))
            .run(),
        );
        memory.delete(cacheKey(ns, key));
      });

    const getOrFetch = <T, E, R>(
      ns: string,
      key: string,
      fetcher: () => Effect.Effect<T, E, R>,
      opts?: CacheSetOptions,
    ): Effect.Effect<T, E | DbError, R> =>
      Effect.gen(function* () {
        const existing = yield* get<T>(ns, key);
        if (existing !== null) return existing;

        const dedupKey = cacheKey(ns, key);
        const pending = inflight.get(dedupKey);
        if (pending) {
          inflightDedups++;
          const exit = yield* Effect.promise(() => pending as Promise<Exit.Exit<T, E>>);
          return yield* exit;
        }

        // The Promise carries the fetcher's Exit and never rejects, so every
        // caller, owner and joiner alike, sees a typed failure in the error
        // channel. A rejecting Promise would reach joiners as a defect, slipping
        // past their `catchAll`.
        const runtime = yield* Effect.context<R>();
        const promise = Effect.runPromiseWith(runtime)(
          fetcher().pipe(
            Effect.tap((value) =>
              set(ns, key, value, opts).pipe(Effect.orElseSucceed(() => undefined)),
            ),
            Effect.exit,
          ),
        );

        // The entry lives exactly as long as the fetch, which runs detached:
        // an interrupted owner leaves it running, and a later caller must join
        // it rather than start a second one. Settling drops it, failure
        // included, so a failed fetch is never replayed to the next caller.
        inflight.set(dedupKey, promise);
        void promise.then(() => {
          if (inflight.get(dedupKey) === promise) inflight.delete(dedupKey);
        });
        const exit = yield* Effect.promise(() => promise);
        return yield* exit;
      });

    const stats = () =>
      Effect.gen(function* () {
        const rows = yield* dbTry("cache.stats scan", () =>
          db.select({ ns: kvCache.ns }).from(kvCache).all(),
        );
        const counts = new Map<string, number>();
        for (const row of rows) {
          counts.set(row.ns, (counts.get(row.ns) ?? 0) + 1);
        }
        return {
          hits,
          misses,
          inflightDedups,
          namespaces: [...counts.entries()].map(([ns, entries]) => ({ ns, entries })),
        } satisfies CacheStatsSnapshot;
      });

    return { get, set, invalidate, getOrFetch, stats };
  }),
);
