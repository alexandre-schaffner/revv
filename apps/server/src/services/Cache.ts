import { and, eq, lt } from "drizzle-orm";
import { Context, Effect, Layer, Runtime } from "effect";
import { kvCache } from "../db/schema/index";
import { DbService } from "./Db";

/**
 * Options governing a single `set` (or `getOrFetch`) write.
 *
 * Exactly one of `ttlMs` or `immutable` should be meaningful in practice —
 * passing `immutable: true` clears any `ttlMs`, and keys that legitimately
 * never go stale (anything containing `headSha` / `baseSha` / `ref`) should
 * set `immutable: true` so the row isn't swept by the expiry check.
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
 * Generic multi-tier cache: in-memory hot layer + `kv_cache` durable layer.
 *
 * Designed for **small metadata blobs** — things like the GitHub repos list,
 * the authenticated-user payload, TTL-scoped lookups. For immutable large
 * bodies (diffs, file contents, AI explanations), use their purpose-built
 * tables — they already carry referential integrity and richer queries.
 *
 * ### Semantics
 *
 * - `get` returns `null` on miss OR on expired TTL (TTL entries are only
 *   expired *lazily* on read; no background sweeper).
 * - `set` with `immutable: true` writes `expires_at = NULL`; callers can
 *   store indefinitely and invalidate explicitly.
 * - `set` with `ttlMs` writes `expires_at = now + ttlMs`. No TTL + no
 *   immutable ⇒ rejected at runtime (treated as immutable) so a caller
 *   doesn't silently leak unbounded rows.
 * - `getOrFetch` deduplicates concurrent calls for the same `(ns, key)` via
 *   an in-memory Promise map. The fetcher runs once; all concurrent callers
 *   await the same result.
 * - `invalidate(ns)` drops the whole namespace; `invalidate(ns, key)` drops
 *   one row. Both clear any matching in-memory entries too.
 *
 * Stats are best-effort, in-memory only, and reset on process restart.
 */
export class CacheService extends Context.Tag("CacheService")<
  CacheService,
  {
    readonly get: <T>(
      ns: string,
      key: string,
    ) => Effect.Effect<T | null, never, DbService>;
    readonly set: <T>(
      ns: string,
      key: string,
      value: T,
      opts?: CacheSetOptions,
    ) => Effect.Effect<void, never, DbService>;
    readonly invalidate: (
      ns: string,
      key?: string,
    ) => Effect.Effect<void, never, DbService>;
    readonly getOrFetch: <T, E, R>(
      ns: string,
      key: string,
      fetcher: () => Effect.Effect<T, E, R>,
      opts?: CacheSetOptions,
    ) => Effect.Effect<T, E, R | DbService>;
    readonly stats: () => Effect.Effect<CacheStatsSnapshot, never, DbService>;
  }
>() {}

export const CacheServiceLive = Layer.sync(CacheService, () => {
  // Hot-path mirror so repeated reads don't hit SQLite. Values expire on read
  // (lazy) just like the durable layer.
  type MemEntry = { value: unknown; expiresAt: number | null };
  const memory = new Map<string, MemEntry>();
  const cacheKey = (ns: string, key: string) => `${ns}\0${key}`;

  // In-flight dedup — one Promise per (ns,key) shared across concurrent callers.
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
    if (isExpired(entry.expiresAt)) {
      memory.delete(k);
      return undefined;
    }
    return entry.value;
  };

  const writeMemory = (
    ns: string,
    key: string,
    value: unknown,
    expiresAt: number | null,
  ): void => {
    memory.set(cacheKey(ns, key), { value, expiresAt });
  };

  const get = <T>(ns: string, key: string) =>
    Effect.gen(function* () {
      const mem = readMemory(ns, key);
      if (mem !== undefined) {
        hits++;
        return mem as T;
      }

      const { db } = yield* DbService;
      const row = db
        .select({
          valueJson: kvCache.valueJson,
          expiresAt: kvCache.expiresAt,
        })
        .from(kvCache)
        .where(and(eq(kvCache.ns, ns), eq(kvCache.key, key)))
        .get();

      if (!row) {
        misses++;
        return null;
      }

      const expiresAt = parseIso(row.expiresAt);
      if (isExpired(expiresAt)) {
        // Lazy eviction: row is stale, drop it + register a miss.
        db.delete(kvCache)
          .where(and(eq(kvCache.ns, ns), eq(kvCache.key, key)))
          .run();
        misses++;
        return null;
      }

      let parsed: T;
      try {
        parsed = JSON.parse(row.valueJson) as T;
      } catch {
        // Corrupt JSON — treat as a miss so the next call overwrites.
        misses++;
        return null;
      }

      writeMemory(ns, key, parsed, expiresAt);
      hits++;
      return parsed;
    });

  const set = <T>(
    ns: string,
    key: string,
    value: T,
    opts: CacheSetOptions = {},
  ) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const now = Date.now();
      const expiresAt = opts.immutable
        ? null
        : typeof opts.ttlMs === "number"
          ? new Date(now + opts.ttlMs).toISOString()
          : null; // default to immutable — forces callers to opt-in to TTL
      const expiresAtMs = expiresAt ? Date.parse(expiresAt) : null;
      const valueJson = JSON.stringify(value);
      const fetchedAt = new Date(now).toISOString();

      db.insert(kvCache)
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
        .run();

      writeMemory(ns, key, value, expiresAtMs);
    });

  const invalidate = (ns: string, key?: string) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      if (key === undefined) {
        db.delete(kvCache).where(eq(kvCache.ns, ns)).run();
        // Drop every matching in-memory entry too.
        const prefix = `${ns}\0`;
        for (const k of memory.keys()) {
          if (k.startsWith(prefix)) memory.delete(k);
        }
      } else {
        db.delete(kvCache)
          .where(and(eq(kvCache.ns, ns), eq(kvCache.key, key)))
          .run();
        memory.delete(cacheKey(ns, key));
      }
    });

  const getOrFetch = <T, E, R>(
    ns: string,
    key: string,
    fetcher: () => Effect.Effect<T, E, R>,
    opts?: CacheSetOptions,
  ): Effect.Effect<T, E, R | DbService> =>
    Effect.gen(function* () {
      const existing = yield* get<T>(ns, key);
      if (existing !== null) return existing;

      const dedupKey = cacheKey(ns, key);
      const pending = inflight.get(dedupKey);
      if (pending) {
        inflightDedups++;
        return (yield* Effect.promise(() => pending as Promise<T>)) as T;
      }

      // Materialize the fetcher as a Promise so concurrent callers can share
      // it. We still surface errors through Effect's error channel via the
      // sync path below.
      // The fetcher chain also writes through `set`, which requires
      // DbService. Grab a runtime that carries both.
      const runtime = yield* Effect.runtime<R | DbService>();
      const runPromise = Runtime.runPromise(runtime);
      const promise = new Promise<T>((resolve, reject) => {
        const eff = fetcher().pipe(
          Effect.tap((value) =>
            set(ns, key, value, opts).pipe(
              Effect.orElseSucceed(() => undefined),
            ),
          ),
        );
        runPromise(eff).then(resolve, reject);
      });

      inflight.set(dedupKey, promise);
      try {
        const value = yield* Effect.tryPromise({
          try: () => promise,
          catch: (err) => err as E,
        });
        return value;
      } finally {
        inflight.delete(dedupKey);
      }
    });

  const stats = () =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      // Sweep expired rows opportunistically — keeps `entries` count honest
      // and prevents the table from accumulating dead TTL rows forever.
      const nowIso = new Date().toISOString();
      db.delete(kvCache).where(lt(kvCache.expiresAt, nowIso)).run();

      const rows = db.select({ ns: kvCache.ns }).from(kvCache).all();
      const counts = new Map<string, number>();
      for (const row of rows) {
        counts.set(row.ns, (counts.get(row.ns) ?? 0) + 1);
      }
      return {
        hits,
        misses,
        inflightDedups,
        namespaces: [...counts.entries()].map(([ns, entries]) => ({
          ns,
          entries,
        })),
      } satisfies CacheStatsSnapshot;
    });

  return { get, set, invalidate, getOrFetch, stats };
});
