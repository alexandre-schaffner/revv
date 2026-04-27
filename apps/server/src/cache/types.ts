/**
 * Shared types used across the unified cache layer.
 *
 * The cache layer is built around three orthogonal axes:
 *   1. **Freshness policy** — when an entry should be treated as stale /
 *      re-fetched (TTL, immutable, SHA-keyed, ETag-driven, …).
 *   2. **Storage backend** — where the bytes live (memory, SQLite, a
 *      layered composite).
 *   3. **Keying** — how caller-facing keys serialize to the backend's
 *      canonical `namespace\0key` string.
 *
 * A {@link CacheLayer} wires these three together for a single namespace
 * (e.g. `github:etag`, `file:content`, `github:graphql`).
 */

/**
 * Metadata a policy can stamp on a row when it writes. Opaque from the
 * backend's perspective — the backend only persists `tagJson` blindly. The
 * policy reads it back on subsequent `get`s to make freshness decisions.
 */
export interface PolicyWriteMeta {
  /** ETag from upstream. Used by the {@link EtagPolicy}. */
  readonly etag?: string;
  /** Last-Modified from upstream. */
  readonly lastModified?: string;
  /**
   * Opaque tag — policies store their own discriminator here (e.g. the
   * `headSha` for {@link ShaKeyedPolicy}, the query hash for
   * {@link QueryHashPolicy}).
   */
  readonly tag?: Record<string, unknown>;
  /**
   * Explicit TTL override. If omitted, the policy picks a default.
   * A value of `null` means "no expiry".
   */
  readonly ttlMs?: number | null;
}

/**
 * Persistent row shape — every backend stores (and returns) this.
 *
 * Note: `valueJson` is kept as a string so the backend can persist without
 * caring about the shape of `V`. Callers go through a {@link CacheLayer},
 * which handles (de)serialization.
 */
export interface CacheRow {
  readonly ns: string;
  readonly key: string;
  readonly valueJson: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly tagJson: string | null;
  readonly fetchedAt: string; // ISO-8601
  readonly expiresAt: string | null; // ISO-8601 or null
  readonly approxBytes: number;
}

/** Hint passed into `getOrFetch` fetchers so they can make conditional requests. */
export interface RevalidationHint<V> {
  /** The previously cached value, if any. Useful for SWR fetchers. */
  readonly previousValue: V | null;
  /** Previous ETag, if the policy captured one. */
  readonly previousEtag: string | null;
  /** Previous Last-Modified, if the policy captured one. */
  readonly previousLastModified: string | null;
  /** The row we're revalidating (if we have one). */
  readonly previousRow: CacheRow | null;
}

/**
 * Fetcher return value. Three variants let the policy distinguish between
 * a real refresh, a 304-style no-op, and an upstream-removed resource.
 */
export type FetcherResult<V> =
  | {
      readonly kind: "fresh";
      readonly value: V;
      readonly meta?: PolicyWriteMeta;
    }
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid" };

/** Aggregate observability shape surfaced via `/api/cache/stats`. */
export interface CacheNamespaceStats {
  readonly namespace: string;
  readonly policy: string;
  readonly storage: "memory" | "sqlite" | "layered";
  readonly hits: number;
  readonly misses: number;
  readonly revalidatedUnchanged: number;
  readonly inflightDedups: number;
  readonly bytesSaved: number;
  readonly entries: number;
  readonly approxBytes: number;
  readonly hitRate: number;
  readonly oldestEntryAt: string | null;
  readonly newestEntryAt: string | null;
}

/**
 * Granular counters a {@link CacheLayer} reports. The aggregated shape above
 * derives `hitRate` from `hits / (hits + misses)`.
 */
export interface CacheCounters {
  hits: number;
  misses: number;
  revalidatedUnchanged: number;
  inflightDedups: number;
  bytesSaved: number;
}
