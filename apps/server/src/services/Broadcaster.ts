// ── Broadcaster (Realtime / Events) ─────────────────────────────────────────
//
// The realtime/events narrow neck. Account-scoped pub-sub for the global SSE
// stream that replaces the per-PR walkthrough SSE. Each connected client owns
// one writer registered under the account id resolved from their bearer token;
// broadcasts fan out to every writer for the target account.
//
// This is the deep module the module map calls "Realtime/Events": a tiny
// interface (`register` / `broadcast` / `broadcastToAccount`) hides the
// best-effort fan-out, SSE encoding, and disconnect bookkeeping. Features push
// events here; they never touch transport internals.
//
// Scope (intentional): only walkthrough envelopes flow through here today.
// Other real-time channels (PR/repo/chat/new-pr-session WS envelopes) keep
// using `WebSocketHub`, the legacy transport, until they migrate. Add new
// envelope types to `ServerEventMessage` in `@revv/shared/src/events` as each
// subsystem moves — the union lives entirely in `@revv/shared`, never here.
//
// Doctrine: commit-first, broadcast-second (invariant #8). This service is
// the broadcast point — callers MUST commit to SQLite first. Lost
// broadcasts are reconstructible from DB on reconnect via the snapshot
// REST endpoints. The interface carries no sequence cursor: the walkthrough
// emitter owns `bumpSeq` (durable wire cursor) / `nextSeq` (in-memory
// diagnostic) and stamps `seq` onto the envelope before it reaches here.

import type { ServerEventMessage } from "@revv/shared";
import { Context, Effect, Layer, Ref } from "effect";

const encoder = new TextEncoder();

/**
 * Minimal writer surface the SSE route exposes to the broadcaster. A writer:
 *   - encodes a JS object as an SSE `data:` frame and enqueues it
 *   - returns false if the underlying controller has been torn down
 *     (client disconnect, controller.close() raced with broadcast, etc.)
 *
 * The route owns lifecycle (controller, heartbeat); the broadcaster only sees
 * this narrow interface so the two concerns stay separable.
 */
export interface EventWriter {
  /** Write a JS value as a single `data: <json>\n\n` frame. */
  send: (event: unknown) => boolean;
  /** True after the client has disconnected. */
  isClosed: () => boolean;
}

interface Registration {
  readonly id: number;
  readonly accountId: string;
  readonly writer: EventWriter;
}

export class Broadcaster extends Context.Tag("Broadcaster")<
  Broadcaster,
  {
    /**
     * Register a writer for the given account. Returns an unsubscribe fn
     * the route MUST call from its disconnect / close hook.
     */
    readonly register: (accountId: string, writer: EventWriter) => Effect.Effect<() => void>;

    /** Best-effort broadcast to every writer registered for `accountId`. */
    readonly broadcastToAccount: (
      accountId: string,
      msg: ServerEventMessage,
    ) => Effect.Effect<void>;

    /** Best-effort fan to every registered writer. */
    readonly broadcast: (msg: ServerEventMessage) => Effect.Effect<void>;

    /** Diagnostic — how many writers are currently open. */
    readonly clientCount: Effect.Effect<number>;
  }
>() {}

export const BroadcasterLive = Layer.effect(
  Broadcaster,
  Effect.gen(function* () {
    const registrations = yield* Ref.make(new Set<Registration>());
    let nextId = 0;

    const dispatch = (target: Registration, msg: ServerEventMessage): void => {
      if (target.writer.isClosed()) return;
      // Encoding once per message would shave work for a global fan; today
      // every walkthrough event is account-scoped so per-target encoding is
      // fine and keeps the writer surface from leaking SSE encoding details.
      try {
        target.writer.send(msg);
      } catch {
        // Writer's `send` already swallows enqueue failures and flips
        // `isClosed`; if a throw escapes that contract just drop silently.
      }
    };

    return {
      register: (accountId, writer) =>
        Effect.gen(function* () {
          const reg: Registration = { id: nextId++, accountId, writer };
          yield* Ref.update(registrations, (set) => {
            const next = new Set(set);
            next.add(reg);
            return next;
          });
          return () => {
            // Schedule unregister without forcing the route to await an
            // Effect — close hooks in Elysia/Bun are synchronous.
            void Effect.runPromise(
              Ref.update(registrations, (set) => {
                const next = new Set(set);
                next.delete(reg);
                return next;
              }),
            );
          };
        }),

      broadcastToAccount: (accountId, msg) =>
        Effect.gen(function* () {
          const set = yield* Ref.get(registrations);
          for (const reg of set) {
            if (reg.accountId !== accountId) continue;
            dispatch(reg, msg);
          }
        }),

      broadcast: (msg) =>
        Effect.gen(function* () {
          const set = yield* Ref.get(registrations);
          for (const reg of set) {
            dispatch(reg, msg);
          }
        }),

      clientCount: Effect.map(Ref.get(registrations), (set) => set.size),
    };
  }),
);

// ── SSE frame encoding helpers (used by the route, exported for parity) ─────

/**
 * Encode a JS value as a single SSE `data:` frame, including the double
 * newline terminator. Exported so the route's writer wrapper and tests
 * share one implementation.
 */
export function encodeSseFrame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Encode a `: ping` comment frame (keepalive, never reaches `onmessage`). */
export function encodeSseHeartbeat(): Uint8Array {
  return encoder.encode(": ping\n\n");
}
