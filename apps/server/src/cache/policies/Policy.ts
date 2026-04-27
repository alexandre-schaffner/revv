import type { CacheRow, FetcherResult, PolicyWriteMeta } from "../types";

/**
 * A freshness policy decides two things:
 *
 *   1. **On read** — given a stored row, is it still valid? Can we serve it
 *      as-is, should we force a refresh, or should we drop it entirely?
 *   2. **On write** — given a fetcher result and policy-provided write meta,
 *      what row should we persist? Specifically: what's the `expiresAt` and
 *      what opaque tag goes into `tagJson`?
 *
 * Policies are **value-oriented** (not `Effect`-oriented) — they don't touch
 * the database or the clock except through injected primitives, so they're
 * trivially unit-testable.
 */
export interface Policy {
  /** Stable label surfaced in stats — e.g. 'ttl', 'immutable', 'etag'. */
  readonly kind: string;

  /**
   * Decide whether a stored row is fresh, stale, or should be dropped.
   *
   * The cache layer invokes this on every `get` / `getOrFetch`.
   *
   * - `'fresh'` — serve from cache, no network.
   * - `'stale'` — cache layer will refetch; fetcher receives the previous
   *   value via {@link RevalidationHint} so it can do conditional requests.
   * - `'drop'` — cache layer deletes the row and treats as miss.
   */
  decideRead(row: CacheRow, now: number): "fresh" | "stale" | "drop";

  /**
   * Compute the stored row for a fetcher result. Returns the fields the
   * cache layer should write (or `null` for 'invalid' upstream responses).
   *
   * The `fresh` case produces the row. The `unchanged` case returns a
   * "touch" directive that refreshes `fetchedAt` on the existing row
   * without rewriting `valueJson`. The `invalid` case asks the cache to
   * delete the row.
   */
  decideWrite<V>(
    result: FetcherResult<V>,
    previous: CacheRow | null,
    now: number,
  ): WriteDecision;
}

/** The write-path output a policy produces. */
export type WriteDecision =
  | {
      readonly kind: "persist";
      /** Serialized value — policy produced this from FetcherResult.value. */
      readonly valueJson: string;
      readonly etag: string | null;
      readonly lastModified: string | null;
      readonly tagJson: string | null;
      readonly fetchedAt: string;
      readonly expiresAt: string | null;
      readonly approxBytes: number;
    }
  | {
      readonly kind: "touch";
      readonly fetchedAt: string;
      readonly expiresAt: string | null;
    }
  | { readonly kind: "drop" };

/** Small utilities shared by policy implementations. */

export function isoNow(now: number): string {
  return new Date(now).toISOString();
}

export function parseIso(s: string | null): number | null {
  if (s === null) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function approxBytes(s: string): number {
  // Approximate UTF-8 byte length without a full encode pass.
  // 2× the length is a cheap-and-safe upper bound for mostly-ASCII blobs.
  return s.length * 2;
}

export function serializeValue<V>(value: V): {
  valueJson: string;
  approxBytes: number;
} {
  const valueJson = JSON.stringify(value);
  return { valueJson, approxBytes: approxBytes(valueJson) };
}

export function serializeTag(
  tag: Record<string, unknown> | undefined,
): string | null {
  if (!tag) return null;
  return JSON.stringify(tag);
}

export function readTag<T extends Record<string, unknown>>(
  tagJson: string | null,
): T | null {
  if (!tagJson) return null;
  try {
    return JSON.parse(tagJson) as T;
  } catch {
    return null;
  }
}

/**
 * Build a `persist` decision from a fresh fetcher result.
 *
 * Centralizes the serialization + meta-merge path so individual policies
 * only have to decide "what's the expiry and what's the tag?".
 */
export function buildPersist<V>(args: {
  value: V;
  meta: PolicyWriteMeta | undefined;
  tag: Record<string, unknown> | null;
  ttlMs: number | null;
  now: number;
}): WriteDecision {
  const { value, meta, tag, ttlMs, now } = args;
  const { valueJson, approxBytes: bytes } = serializeValue(value);
  const expiresAt = ttlMs === null ? null : isoNow(now + ttlMs);
  return {
    kind: "persist",
    valueJson,
    etag: meta?.etag ?? null,
    lastModified: meta?.lastModified ?? null,
    tagJson: serializeTag(tag ?? undefined),
    fetchedAt: isoNow(now),
    expiresAt,
    approxBytes: bytes,
  };
}
