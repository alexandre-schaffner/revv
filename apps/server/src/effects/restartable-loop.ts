import { Effect, Fiber, Ref, type Scope } from "effect";

/**
 * The fiber is forked into the scope of whoever made the handle — a
 * `Layer.scoped` service's own scope, which lasts as long as the runtime and
 * interrupts the loop on shutdown. Forked under `start()`'s caller instead, it
 * would be interrupted the moment `start()` returned, before its first tick.
 */
export interface RestartableLoop {
  readonly start: (loop: Effect.Effect<unknown>) => Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly isRunning: Effect.Effect<boolean>;
}

export const makeRestartableLoop: Effect.Effect<RestartableLoop, never, Scope.Scope> = Effect.gen(
  function* () {
    const scope = yield* Effect.scope;
    const fiberRef = yield* Ref.make<Fiber.Fiber<unknown> | null>(null);

    return {
      start: (loop) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(fiberRef)) !== null) return;
          yield* Ref.set(fiberRef, yield* Effect.forkIn(loop, scope));
        }),
      stop: Effect.gen(function* () {
        const fiber = yield* Ref.get(fiberRef);
        if (fiber === null) return;
        yield* Fiber.interrupt(fiber);
        yield* Ref.set(fiberRef, null);
      }),
      isRunning: Effect.map(Ref.get(fiberRef), (fiber) => fiber !== null),
    };
  },
);
