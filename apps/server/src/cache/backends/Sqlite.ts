import { and, eq, like, lt, max, min, sql } from "drizzle-orm";
import { Effect } from "effect";
import { cacheEntries } from "../../db/schema/index";
import { DbService } from "../../services/Db";
import type { StorageBackend } from "../Storage";
import type { CacheRow } from "../types";

/**
 * Durable backend backed by the consolidated `cache_entries` SQLite table.
 *
 * Uses Drizzle + `bun:sqlite`. All writes are upserts on `(ns, key)`.
 *
 * SQLite is synchronous in Bun's binding, so the Effect wrappers here are
 * thin — they exist only for composition with the rest of the Effect-based
 * service graph, not to move I/O off-thread.
 */
export function createSqliteBackend(): StorageBackend {
  const readOne = (ns: string, key: string) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select()
        .from(cacheEntries)
        .where(and(eq(cacheEntries.ns, ns), eq(cacheEntries.key, key)))
        .get();
      if (!row) return null;
      return {
        ns: row.ns,
        key: row.key,
        valueJson: row.valueJson,
        etag: row.etag,
        lastModified: row.lastModified,
        tagJson: row.tagJson,
        fetchedAt: row.fetchedAt,
        expiresAt: row.expiresAt,
        approxBytes: row.approxBytes,
      } satisfies CacheRow;
    });

  const writeOne = (row: CacheRow) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.insert(cacheEntries)
        .values(row)
        .onConflictDoUpdate({
          target: [cacheEntries.ns, cacheEntries.key],
          set: {
            valueJson: row.valueJson,
            etag: row.etag,
            lastModified: row.lastModified,
            tagJson: row.tagJson,
            fetchedAt: row.fetchedAt,
            expiresAt: row.expiresAt,
            approxBytes: row.approxBytes,
          },
        })
        .run();
    });

  const deleteOne = (ns: string, key: string) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.delete(cacheEntries)
        .where(and(eq(cacheEntries.ns, ns), eq(cacheEntries.key, key)))
        .run();
    });

  const escapeLike = (s: string): string =>
    // SQLite LIKE uses % and _ as wildcards; escape them so user-supplied
    // prefixes match literally.
    s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

  const deleteByPrefix = (ns: string, keyPrefix: string) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const escaped = escapeLike(keyPrefix);
      db.delete(cacheEntries)
        .where(
          and(eq(cacheEntries.ns, ns), like(cacheEntries.key, `${escaped}%`)),
        )
        .run();
    });

  const deleteNamespace = (ns: string) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.delete(cacheEntries).where(eq(cacheEntries.ns, ns)).run();
    });

  const countEntries = (ns: string) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({
          entries: sql<number>`COUNT(*)`,
          approxBytes: sql<number>`COALESCE(SUM(${cacheEntries.approxBytes}), 0)`,
        })
        .from(cacheEntries)
        .where(eq(cacheEntries.ns, ns))
        .get();
      return {
        entries: row?.entries ?? 0,
        approxBytes: row?.approxBytes ?? 0,
      };
    });

  const bounds = (ns: string) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({
          oldest: min(cacheEntries.fetchedAt),
          newest: max(cacheEntries.fetchedAt),
        })
        .from(cacheEntries)
        .where(eq(cacheEntries.ns, ns))
        .get();
      return {
        oldestAt: row?.oldest ?? null,
        newestAt: row?.newest ?? null,
      };
    });

  const sweepExpired = () =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const nowIso = new Date().toISOString();
      // Count first so we can report how many rows we'll purge. `COUNT(*)` on
      // the filtered set is cheap with the `cache_entries_expires_at_idx`
      // partial-ish index (SQLite's LT scan terminates at the first non-match).
      const row = db
        .select({ n: sql<number>`COUNT(*)` })
        .from(cacheEntries)
        .where(lt(cacheEntries.expiresAt, nowIso))
        .get();
      const count = row?.n ?? 0;
      db.delete(cacheEntries).where(lt(cacheEntries.expiresAt, nowIso)).run();
      return count;
    });

  return {
    kind: "sqlite",
    readOne,
    writeOne,
    deleteOne,
    deleteByPrefix,
    deleteNamespace,
    countEntries,
    bounds,
    sweepExpired,
  };
}
