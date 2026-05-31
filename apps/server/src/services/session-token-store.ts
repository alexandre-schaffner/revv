// ── Session-token store ────────────────────────────────────────────────────
//
// Ephemeral bearer-token registry used by the opencode HTTP-MCP routes to
// authenticate per-job tool calls. Each active job issues one (or more)
// opaque tokens bound to a payload; the route resolves token → payload per
// JSON-RPC call. Tokens expire after the runner's time budget plus slack.
//
// Per CLAUDE.md invariant #1 this is coordination-cache only: a server
// restart wipes the map; the orchestrator's resume path re-issues tokens.
//
// Two callers, one shared substrate:
//   • Recap passes no `liveCheck` — a token resolves to its stored payload
//     for as long as it hasn't expired, regardless of fiber liveness.
//   • Walkthrough injects a `liveCheck` so a token stops resolving the moment
//     its job leaves the in-memory registry (the job died), even before TTL.
// This is the one real behavioral difference between the two; keep it.

import { Effect, Ref } from "effect";

interface Entry<T> {
  readonly payload: T;
  readonly expiresAt: number;
}

export interface SessionTokenStore<T> {
  /** Mint a fresh token bound to `payload`. Returns the opaque bearer token. */
  readonly issue: (payload: T) => Effect.Effect<string>;
  /**
   * Resolve a token to its payload, or `null` if unknown, expired, or — when a
   * `liveCheck` was supplied — no longer live. Expired tokens are evicted as a
   * side effect.
   */
  readonly resolve: (token: string) => Effect.Effect<T | null>;
  /** Invalidate a single token early (e.g. on job cancel). Silent if absent. */
  readonly clear: (token: string) => Effect.Effect<void>;
  /** Evict every token whose payload matches `predicate` (e.g. job teardown). */
  readonly clearWhere: (predicate: (payload: T) => boolean) => Effect.Effect<void>;
}

export const makeSessionTokenStore = <T>(
  ttlMs: number,
  liveCheck?: (payload: T) => Effect.Effect<boolean>,
): Effect.Effect<SessionTokenStore<T>> =>
  Effect.gen(function* () {
    const tokens = yield* Ref.make(new Map<string, Entry<T>>());

    const issue = (payload: T): Effect.Effect<string> =>
      Effect.gen(function* () {
        const token = crypto.randomUUID();
        yield* Ref.update(tokens, (map) => {
          const next = new Map(map);
          next.set(token, { payload, expiresAt: Date.now() + ttlMs });
          return next;
        });
        return token;
      });

    const resolve = (token: string): Effect.Effect<T | null> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(tokens);
        const entry = map.get(token);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
          yield* clear(token);
          return null;
        }
        if (liveCheck && !(yield* liveCheck(entry.payload))) return null;
        return entry.payload;
      });

    const clear = (token: string): Effect.Effect<void> =>
      Ref.update(tokens, (map) => {
        if (!map.has(token)) return map;
        const next = new Map(map);
        next.delete(token);
        return next;
      });

    const clearWhere = (predicate: (payload: T) => boolean): Effect.Effect<void> =>
      Ref.update(tokens, (map) => {
        let changed = false;
        const next = new Map(map);
        for (const [token, entry] of next) {
          if (predicate(entry.payload)) {
            next.delete(token);
            changed = true;
          }
        }
        return changed ? next : map;
      });

    return { issue, resolve, clear, clearWhere };
  });
