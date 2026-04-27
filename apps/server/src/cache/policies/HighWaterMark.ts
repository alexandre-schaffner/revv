import type { CacheRow, FetcherResult } from "../types";
import {
  buildPersist,
  isoNow,
  type Policy,
  readTag,
  type WriteDecision,
} from "./Policy";

/**
 * High-water-mark freshness: the cache stores a cursor (e.g. the last
 * synced `updated_at` for a PR's comments) in the tag, and treats any read
 * as 'fresh' — it exists to normalize the cursor access pattern, not to
 * expire entries.
 *
 * Useful as a thin wrapper for the `commentsSyncedAt` pattern today kept
 * on the `pull_requests` table, so it can surface in the unified stats
 * dashboard even though the backing column lives elsewhere.
 */
export interface WatermarkTag extends Record<string, unknown> {
  readonly watermark: string;
}

export class HighWaterMarkPolicy implements Policy {
  readonly kind = "high-water-mark";

  decideRead(row: CacheRow, _now: number): "fresh" | "stale" | "drop" {
    const tag = readTag<WatermarkTag>(row.tagJson);
    return tag ? "fresh" : "drop";
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
        return { kind: "touch", fetchedAt: isoNow(now), expiresAt: null };
      case "fresh": {
        const tag = (result.meta?.tag ?? null) as WatermarkTag | null;
        return buildPersist({
          value: result.value,
          meta: result.meta,
          tag,
          ttlMs: null,
          now,
        });
      }
    }
  }
}
