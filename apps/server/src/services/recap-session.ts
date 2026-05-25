// ── Recap session token manager ───────────────────────────────────────────────
//
// Ephemeral bearer-token registry that the opencode HTTP-MCP route uses to
// authenticate per-job tool calls. Each active recap job issues one token
// bound to its RecapToolContext; the route resolves token → context per
// JSON-RPC call. Tokens expire after the runner's 10-minute cap plus slack.
//
// Per CLAUDE.md invariant #1 this is coordination-cache only: a server
// restart wipes the map; the orchestrator's resume path rebuilds it.

import { Effect, Ref } from "effect";
import type { RecapToolContext } from "../ai/providers/recap-tools";

interface SessionEntry {
  readonly ctx: RecapToolContext;
  readonly expiresAt: number;
}

export interface RecapSessionManager {
  readonly issueSessionToken: (ctx: RecapToolContext) => Effect.Effect<string>;
  readonly resolveSessionToken: (token: string) => Effect.Effect<RecapToolContext | null>;
  readonly clearSessionToken: (token: string) => Effect.Effect<void>;
  readonly clearTokensForRecap: (recapId: string) => Effect.Effect<void>;
}

export const makeRecapSessionManager = (ttlMs: number): Effect.Effect<RecapSessionManager> =>
  Effect.gen(function* () {
    const tokens = yield* Ref.make(new Map<string, SessionEntry>());

    const issueSessionToken = (ctx: RecapToolContext): Effect.Effect<string> =>
      Effect.gen(function* () {
        const token = crypto.randomUUID();
        yield* Ref.update(tokens, (map) => {
          const next = new Map(map);
          next.set(token, { ctx, expiresAt: Date.now() + ttlMs });
          return next;
        });
        return token;
      });

    const resolveSessionToken = (token: string): Effect.Effect<RecapToolContext | null> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(tokens);
        const entry = map.get(token);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
          yield* Ref.update(tokens, (m) => {
            if (!m.has(token)) return m;
            const next = new Map(m);
            next.delete(token);
            return next;
          });
          return null;
        }
        return entry.ctx;
      });

    const clearSessionToken = (token: string): Effect.Effect<void> =>
      Ref.update(tokens, (map) => {
        if (!map.has(token)) return map;
        const next = new Map(map);
        next.delete(token);
        return next;
      });

    const clearTokensForRecap = (recapId: string): Effect.Effect<void> =>
      Ref.update(tokens, (map) => {
        let changed = false;
        const next = new Map(map);
        for (const [token, entry] of next) {
          if (entry.ctx.recapId === recapId) {
            next.delete(token);
            changed = true;
          }
        }
        return changed ? next : map;
      });

    return { issueSessionToken, resolveSessionToken, clearSessionToken, clearTokensForRecap };
  });
