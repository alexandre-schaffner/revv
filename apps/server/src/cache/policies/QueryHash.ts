import { createHash } from "node:crypto";
import type { CacheRow, FetcherResult } from "../types";
import {
  buildPersist,
  isoNow,
  type Policy,
  readTag,
  type WriteDecision,
} from "./Policy";

/**
 * GraphQL query-hash freshness: entries are tagged with the hash of the
 * (query, variables) pair. A short TTL handles the common case where
 * clients re-issue the same GraphQL query within a poll window; the tag
 * guards against variable drift.
 */
export interface QueryHashTag extends Record<string, unknown> {
  readonly queryHash: string;
}

export class QueryHashPolicy implements Policy {
  readonly kind = "query-hash";

  constructor(
    private readonly ttlMs: number,
    private readonly expectedHash: () => string | null = () => null,
  ) {}

  decideRead(row: CacheRow, now: number): "fresh" | "stale" | "drop" {
    const stored = readTag<QueryHashTag>(row.tagJson);
    if (!stored) return "drop";
    const expected = this.expectedHash();
    if (expected && stored.queryHash !== expected) return "drop";
    const age = now - Date.parse(row.fetchedAt);
    return age <= this.ttlMs ? "fresh" : "stale";
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
      case "fresh": {
        const tag = (result.meta?.tag ?? null) as QueryHashTag | null;
        return buildPersist({
          value: result.value,
          meta: result.meta,
          tag,
          ttlMs: this.ttlMs,
          now,
        });
      }
    }
  }
}

/** Hashes a GraphQL (query, variables) pair into a stable tag value. */
export function hashGraphqlQuery(query: string, variables: unknown): string {
  const canonical = JSON.stringify({ q: query, v: variables ?? null });
  return createHash("sha256").update(canonical).digest("hex");
}
