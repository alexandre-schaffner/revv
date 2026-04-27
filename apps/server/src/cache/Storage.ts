import type { Effect } from "effect";
import type { DbService } from "../services/Db";
import type { CacheRow } from "./types";

/**
 * Pluggable backend that a {@link CacheLayer} uses for persistence.
 *
 * Every backend stores {@link CacheRow} shape rows keyed by `(ns, key)`. The
 * cache layer serializes / deserializes the value and chooses TTL handling.
 *
 * ### Design notes
 *
 * - `readOne` returns `null` (not `undefined`) so JSON-shaped handlers can
 *   pass the result around uniformly.
 * - `writeOne` is expected to upsert — there's no separate insert/update
 *   distinction at this layer.
 * - `deleteByPrefix` is namespace-scoped and takes a raw key prefix. Clients
 *   that want "drop the whole namespace" should call `deleteNamespace`.
 * - Expiry sweeping lives on the backend interface (`sweepExpired`) because
 *   the backend is the only thing that knows how to walk its own index.
 *
 * Error channel is `never` because cache errors should be observable but not
 * fatal — a failed SQLite write drops to a miss instead of propagating an
 * exception. Backends log internally.
 */
export interface StorageBackend {
  readonly kind: "memory" | "sqlite" | "layered";
  readonly readOne: (
    ns: string,
    key: string,
  ) => Effect.Effect<CacheRow | null, never, DbService>;
  readonly writeOne: (row: CacheRow) => Effect.Effect<void, never, DbService>;
  readonly deleteOne: (
    ns: string,
    key: string,
  ) => Effect.Effect<void, never, DbService>;
  readonly deleteByPrefix: (
    ns: string,
    keyPrefix: string,
  ) => Effect.Effect<void, never, DbService>;
  readonly deleteNamespace: (
    ns: string,
  ) => Effect.Effect<void, never, DbService>;
  readonly countEntries: (
    ns: string,
  ) => Effect.Effect<
    { entries: number; approxBytes: number },
    never,
    DbService
  >;
  readonly bounds: (
    ns: string,
  ) => Effect.Effect<
    { oldestAt: string | null; newestAt: string | null },
    never,
    DbService
  >;
  readonly sweepExpired: () => Effect.Effect<number, never, DbService>;
}
