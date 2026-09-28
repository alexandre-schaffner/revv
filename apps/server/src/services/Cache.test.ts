import { describe, expect, it } from "bun:test";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { createDb } from "../db";
import { CacheService, CacheServiceLive } from "./Cache";
import { DbService } from "./Db";

class FetchFailed extends Data.TaggedError("FetchFailed")<{ readonly reason: string }> {}

function run<A, E>(effect: Effect.Effect<A, E, CacheService | DbService>) {
  const db = createDb(":memory:");
  return Effect.runPromise(
    effect.pipe(Effect.provide(CacheServiceLive), Effect.provide(Layer.succeed(DbService, { db }))),
  );
}

describe("CacheService.getOrFetch", () => {
  // A caller that joins an in-flight fetch must see the fetcher's failure as a
  // typed failure, same as the caller that started it. Surfacing it as a
  // defect slipped past every `catchAll` that degrades an optional lookup —
  // a walkthrough start racing the sizing poll 500'd on a TypeSafe 402.
  it("fails a deduplicated caller through the error channel", async () => {
    const [first, second] = await run(
      Effect.gen(function* () {
        const cache = yield* CacheService;
        const release = yield* Deferred.make<void>();
        const fetcher = () =>
          Deferred.await(release).pipe(
            Effect.zipRight(Effect.fail(new FetchFailed({ reason: "402" }))),
          );

        const a = yield* Effect.fork(Effect.exit(cache.getOrFetch("ns", "k", fetcher)));
        yield* Effect.yieldNow();
        const b = yield* Effect.fork(Effect.exit(cache.getOrFetch("ns", "k", fetcher)));
        yield* Effect.yieldNow();
        yield* Deferred.succeed(release, undefined);
        return [yield* Fiber.join(a), yield* Fiber.join(b)] as const;
      }),
    );

    for (const exit of [first, second]) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause._tag).toBe("Fail");
        expect(Cause.failureOption(exit.cause)).toEqual(
          Option.some(new FetchFailed({ reason: "402" })),
        );
      }
    }
  });

  it("shares a successful fetch with a deduplicated caller", async () => {
    let calls = 0;
    const [a, b] = await run(
      Effect.gen(function* () {
        const cache = yield* CacheService;
        const release = yield* Deferred.make<void>();
        const fetcher = () =>
          Effect.sync(() => calls++).pipe(
            Effect.zipRight(Deferred.await(release)),
            Effect.as("value"),
          );
        const first = yield* Effect.fork(cache.getOrFetch("ns", "k", fetcher, { immutable: true }));
        yield* Effect.yieldNow();
        const second = yield* Effect.fork(
          cache.getOrFetch("ns", "k", fetcher, { immutable: true }),
        );
        yield* Effect.yieldNow();
        yield* Deferred.succeed(release, undefined);
        return [yield* Fiber.join(first), yield* Fiber.join(second)] as const;
      }),
    );
    expect([a, b]).toEqual(["value", "value"]);
    expect(calls).toBe(1);
  });
});
