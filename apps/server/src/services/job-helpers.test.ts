import { describe, expect, it } from "bun:test";
import { Effect, Option } from "effect";
import { makeStartJobMutex } from "./job-mutex";
import {
  makeSubscriberRegistry,
  type SubscriberChannel,
  type SubscriberHandle,
} from "./job-subscribers";
import { makeSessionTokenStore } from "./session-token-store";

describe("makeStartJobMutex", () => {
  it("excludes a second holder of the same key, and only of that key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mutex = yield* makeStartJobMutex();
        const holder = yield* mutex.acquire("pr-a");
        const [sameKey, otherKey] = yield* holder.withPermits(1)(
          Effect.gen(function* () {
            const same = yield* mutex.acquire("pr-a");
            const other = yield* mutex.acquire("pr-b");
            return [
              yield* same.withPermitsIfAvailable(1)(Effect.void),
              yield* other.withPermitsIfAvailable(1)(Effect.void),
            ] as const;
          }),
        );
        expect(Option.isNone(sameKey)).toBe(true);
        expect(Option.isSome(otherKey)).toBe(true);
      }),
    ));
});

describe("makeSessionTokenStore", () => {
  it("issues, resolves, and clears tokens (recap semantics, no liveCheck)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeSessionTokenStore<{ recapId: string }>(60_000);
        const token = yield* store.issue({ recapId: "r1" });
        expect(yield* store.resolve(token)).toEqual({ recapId: "r1" });
        yield* store.clear(token);
        expect(yield* store.resolve(token)).toBeNull();
      }),
    ));

  it("returns null for expired tokens", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeSessionTokenStore<{ recapId: string }>(0);
        const token = yield* store.issue({ recapId: "r1" });
        expect(yield* store.resolve(token)).toBeNull();
      }),
    ));

  it("honors the injected liveness predicate (walkthrough semantics)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = new Set<string>(["wt-live"]);
        const store = yield* makeSessionTokenStore<{ walkthroughId: string }>(60_000, (p) =>
          Effect.succeed(live.has(p.walkthroughId)),
        );
        const liveTok = yield* store.issue({ walkthroughId: "wt-live" });
        const deadTok = yield* store.issue({ walkthroughId: "wt-dead" });
        expect(yield* store.resolve(liveTok)).toEqual({ walkthroughId: "wt-live" });
        // Job died → token stops resolving even within TTL.
        expect(yield* store.resolve(deadTok)).toBeNull();
      }),
    ));
});

type TestEvent = { readonly type: string; readonly n?: number };

function makeChannel(): SubscriberChannel<TestEvent> {
  return { subscribers: new Set<SubscriberHandle<TestEvent>>(), nextSeq: 0 };
}

const config = {
  traceScope: "test",
  errorScope: "test",
  idLabel: "test",
  handleIdPrefix: "h",
};

describe("makeSubscriberRegistry", () => {
  it("buffers pre-flush events then replays them in order on flush", () => {
    const registry = makeSubscriberRegistry<TestEvent>(config);
    const channel = makeChannel();
    const received: TestEvent[] = [];
    const { flush } = registry.subscribe("job", channel, (e) => received.push(e));

    registry.fanOut("job", channel, { type: "a", n: 1 });
    registry.fanOut("job", channel, { type: "b", n: 2 });
    // Buffered — nothing delivered yet.
    expect(received).toEqual([]);

    flush();
    expect(received).toEqual([
      { type: "a", n: 1 },
      { type: "b", n: 2 },
    ]);

    // Post-flush events forward directly.
    registry.fanOut("job", channel, { type: "c", n: 3 });
    expect(received).toEqual([
      { type: "a", n: 1 },
      { type: "b", n: 2 },
      { type: "c", n: 3 },
    ]);
  });

  it("stops delivering to a subscriber after 3 consecutive throws", () => {
    const registry = makeSubscriberRegistry<TestEvent>(config);
    const channel = makeChannel();
    let calls = 0;
    const { flush } = registry.subscribe("job", channel, () => {
      calls += 1;
      throw new Error("always throws");
    });
    flush();

    for (const type of ["1", "2", "3", "4"]) registry.fanOut("job", channel, { type });
    expect(calls).toBe(3);
  });

  it("resets the strike count on a successful delivery", () => {
    const registry = makeSubscriberRegistry<TestEvent>(config);
    const channel = makeChannel();
    const received: string[] = [];
    const { flush } = registry.subscribe("job", channel, (e) => {
      received.push(e.type);
      if (e.type !== "ok") throw new Error("nope");
    });
    flush();

    for (const type of ["1", "2", "ok", "4", "5", "6"]) registry.fanOut("job", channel, { type });
    expect(received).toEqual(["1", "2", "ok", "4", "5", "6"]);
  });

  it("stops replaying a buffer to a subscriber that throws 3 times on flush", () => {
    const registry = makeSubscriberRegistry<TestEvent>(config);
    const channel = makeChannel();
    let calls = 0;
    const { flush } = registry.subscribe("job", channel, () => {
      calls += 1;
      throw new Error("always throws");
    });
    for (const type of ["1", "2", "3", "4"]) registry.fanOut("job", channel, { type });

    flush();
    registry.fanOut("job", channel, { type: "5" });
    expect(calls).toBe(3);
  });

  it("stops delivering to an unsubscribed handle", () => {
    const registry = makeSubscriberRegistry<TestEvent>(config);
    const channel = makeChannel();
    const received: TestEvent[] = [];
    const { unsubscribe, flush } = registry.subscribe("job", channel, (e) => received.push(e));
    flush();
    registry.fanOut("job", channel, { type: "a" });
    unsubscribe();
    registry.fanOut("job", channel, { type: "b" });
    expect(received).toEqual([{ type: "a" }]);
  });
});
