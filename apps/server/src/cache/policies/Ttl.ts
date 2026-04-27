import type { CacheRow, FetcherResult } from "../types";
import {
  buildPersist,
  isoNow,
  type Policy,
  parseIso,
  type WriteDecision,
} from "./Policy";

/**
 * Time-based freshness: every entry carries an `expiresAt = fetchedAt + ttl`.
 *
 * Reads return 'fresh' while before expiry, 'stale' once past (so callers
 * get a revalidation pass rather than a hard miss — SWR-friendly), or
 * 'drop' if configured with `dropOnExpiry: true` (old behaviour).
 */
export class TtlPolicy implements Policy {
  readonly kind = "ttl";

  constructor(
    private readonly ttlMs: number,
    private readonly opts: { readonly dropOnExpiry?: boolean } = {},
  ) {}

  decideRead(row: CacheRow, now: number): "fresh" | "stale" | "drop" {
    const expiresAt = parseIso(row.expiresAt);
    if (expiresAt === null) return "fresh"; // no TTL — treat as fresh
    if (now <= expiresAt) return "fresh";
    return this.opts.dropOnExpiry ? "drop" : "stale";
  }

  decideWrite<V>(
    result: FetcherResult<V>,
    _previous: CacheRow | null,
    now: number,
  ): WriteDecision {
    switch (result.kind) {
      case "invalid":
        return { kind: "drop" };
      case "unchanged":
        return {
          kind: "touch",
          fetchedAt: isoNow(now),
          expiresAt: isoNow(now + this.ttlMs),
        };
      case "fresh":
        return buildPersist({
          value: result.value,
          meta: result.meta,
          tag: null,
          ttlMs: result.meta?.ttlMs ?? this.ttlMs,
          now,
        });
    }
  }
}
