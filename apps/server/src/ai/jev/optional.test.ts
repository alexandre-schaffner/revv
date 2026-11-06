import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb } from "../../db/index";
import { JevUnavailable } from "../../domain/errors";
import { type CacheService, CacheServiceLive } from "../../services/Cache";
import { DbService } from "../../services/Db";
import { JevService } from "../../services/Jev";
import { cachedJev } from "./optional";

function jev(available: boolean) {
  return Layer.succeed(JevService, {
    ask: (() => Effect.fail(new JevUnavailable({ reason: "disabled" }))) as never,
    isAvailable: () => Effect.succeed(available),
    testConnection: () => Effect.fail(new JevUnavailable({ reason: "unconfigured" })),
  });
}

const KEY = { ns: "test:judgment", key: "k", options: { immutable: true } };

describe("cachedJev", () => {
  it("answers from the cache only while Jev is on", async () => {
    const db = createDb(":memory:");
    const run = <A>(
      available: boolean,
      eff: Effect.Effect<A, never, JevService | CacheService | DbService>,
    ) =>
      Effect.runPromise(
        eff.pipe(
          Effect.provide(Layer.mergeAll(jev(available), CacheServiceLive)),
          Effect.provide(Layer.succeed(DbService, { db })),
        ),
      );
    let judged = 0;
    const judge = () => Effect.sync(() => ++judged);

    expect(await run(true, cachedJev("test", KEY, judge))).toBe(1);
    expect(await run(true, cachedJev("test", KEY, judge))).toBe(1);
    // A judgment cached while Jev was on is not one to act on once it is off.
    expect(await run(false, cachedJev("test", KEY, judge))).toBeNull();
    expect(judged).toBe(1);
  });
});
