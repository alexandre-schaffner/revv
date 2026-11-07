// The transport under `Realtime`: each client connected to `/api/events` is
// registered under its session's local user, and a send fans out to that
// user's clients. Who receives a push is `Realtime`'s business.
//
// The interface carries no sequence cursor: the walkthrough emitter owns
// `bumpSeq` (durable wire cursor) and stamps `seq` onto the envelope before it
// reaches here.

import type { ServerEventMessage } from "@revv/shared";
import { Context, Effect, Layer, Ref } from "effect";
import { logError } from "../logger";

interface EventWriter {
  /** False once the client is gone. */
  readonly send: (event: ServerEventMessage) => boolean;
  readonly isClosed: () => boolean;
}

interface Registration {
  readonly id: number;
  readonly userId: string;
  readonly writer: EventWriter;
}

export class Broadcaster extends Context.Service<
  Broadcaster,
  {
    /** Returns an unsubscribe fn the route MUST call from its close hook. */
    readonly register: (userId: string, writer: EventWriter) => Effect.Effect<() => void>;

    readonly broadcastToUser: (userId: string, msg: ServerEventMessage) => Effect.Effect<void>;
  }
>()("Broadcaster") {}

export const BroadcasterLive = Layer.effect(
  Broadcaster,
  Effect.gen(function* () {
    const registrations = yield* Ref.make(new Set<Registration>());
    let nextId = 0;

    const dispatch = (target: Registration, msg: ServerEventMessage): void => {
      if (target.writer.isClosed()) return;
      try {
        target.writer.send(msg);
      } catch (err) {
        logError("broadcaster", `${msg.type} not sent:`, err instanceof Error ? err.message : err);
      }
    };

    return {
      register: (userId, writer) =>
        Effect.gen(function* () {
          const reg: Registration = { id: nextId++, userId, writer };
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

      broadcastToUser: (userId, msg) =>
        Effect.gen(function* () {
          const set = yield* Ref.get(registrations);
          for (const reg of set) {
            if (reg.userId !== userId) continue;
            dispatch(reg, msg);
          }
        }),
    };
  }),
);
