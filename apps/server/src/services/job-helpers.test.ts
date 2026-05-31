import { describe, expect, it } from "bun:test";
import { Cause, Effect, FiberId } from "effect";
import { analyzeJobFailure } from "./job-failure";
import { makeStartJobMutex } from "./job-mutex";
import {
  makeSubscriberRegistry,
  type SubscriberChannel,
  type SubscriberHandle,
} from "./job-subscribers";
import { makeSessionTokenStore } from "./session-token-store";

// ── analyzeJobFailure ────────────────────────────────────────────────────────
// The cancelledByUser split (invariant #1): only a bare process-shutdown
// interrupt is resume-worthy; a user-cancel or a genuine failure is terminal.

describe("analyzeJobFailure", () => {
  const interrupt = Cause.interrupt(FiberId.none);
  const failure = Cause.fail(new Error("boom"));

  it("leaves shutdown interrupts for resume", () => {
    expect(analyzeJobFailure(interrupt, { cancelledByUser: false })).toBe("leave-for-resume");
  });

  it("errors on user-cancelled interrupts", () => {
    expect(analyzeJobFailure(interrupt, { cancelledByUser: true })).toBe("error");
  });

  it("errors on genuine failures regardless of cancel flag", () => {
    expect(analyzeJobFailure(failure, { cancelledByUser: false })).toBe("error");
    expect(analyzeJobFailure(failure, { cancelledByUser: true })).toBe("error");
  });
});

// ── makeStartJobMutex ────────────────────────────────────────────────────────

describe("makeStartJobMutex", () => {
  it("returns one shared semaphore per key and distinct ones across keys", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mutex = yield* makeStartJobMutex();
        const a1 = yield* mutex.acquire("pr-a");
        const a2 = yield* mutex.acquire("pr-a");
        const b = yield* mutex.acquire("pr-b");
        // Same key → identical semaphore instance (that is what serializes).
        expect(a1).toBe(a2);
        expect(a1).not.toBe(b);
      }),
    ));

  it("serializes critical sections sharing a key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mutex = yield* makeStartJobMutex();
        const sem = yield* mutex.acquire("k");
        let active = 0;
        let maxActive = 0;
        const task = sem.withPermits(1)(
          Effect.gen(function* () {
            active += 1;
            maxActive = Math.max(maxActive, active);
            yield* Effect.sleep("10 millis");
            active -= 1;
          }),
        );
        yield* Effect.all([task, task, task], { concurrency: "unbounded" });
        // Never two at once under the same key.
        expect(maxActive).toBe(1);
      }),
    ));
});

// ── makeSessionTokenStore ────────────────────────────────────────────────────

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
        // TTL 0 → already expired on resolve.
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

  it("clearWhere evicts every matching token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeSessionTokenStore<{ recapId: string }>(60_000);
        const a = yield* store.issue({ recapId: "r1" });
        const b = yield* store.issue({ recapId: "r1" });
        const c = yield* store.issue({ recapId: "r2" });
        yield* store.clearWhere((ctx) => ctx.recapId === "r1");
        expect(yield* store.resolve(a)).toBeNull();
        expect(yield* store.resolve(b)).toBeNull();
        expect(yield* store.resolve(c)).toEqual({ recapId: "r2" });
      }),
    ));
});

// ── makeSubscriberRegistry ───────────────────────────────────────────────────

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

  it("increments the diagnostic seq monotonically", () => {
    const registry = makeSubscriberRegistry<TestEvent>(config);
    const channel = makeChannel();
    expect(registry.fanOut("job", channel, { type: "a" })).toBe(0);
    expect(registry.fanOut("job", channel, { type: "b" })).toBe(1);
    expect(channel.nextSeq).toBe(2);
  });

  it("drops a subscriber after 3 consecutive throws", () => {
    const registry = makeSubscriberRegistry<TestEvent>(config);
    const channel = makeChannel();
    const { flush } = registry.subscribe("job", channel, () => {
      throw new Error("always throws");
    });
    flush(); // switch to direct-forward mode

    expect(channel.subscribers.size).toBe(1);
    registry.fanOut("job", channel, { type: "1" });
    registry.fanOut("job", channel, { type: "2" });
    expect(channel.subscribers.size).toBe(1); // 2 strikes — still alive
    registry.fanOut("job", channel, { type: "3" });
    expect(channel.subscribers.size).toBe(0); // 3rd strike — dropped
  });

  it("resets the strike counter on a successful delivery", () => {
    const registry = makeSubscriberRegistry<TestEvent>(config);
    const channel = makeChannel();
    let mode: "throw" | "ok" = "throw";
    const { flush } = registry.subscribe("job", channel, () => {
      if (mode === "throw") throw new Error("nope");
    });
    flush();

    registry.fanOut("job", channel, { type: "1" });
    registry.fanOut("job", channel, { type: "2" });
    mode = "ok";
    registry.fanOut("job", channel, { type: "3" }); // success resets counter
    mode = "throw";
    registry.fanOut("job", channel, { type: "4" });
    registry.fanOut("job", channel, { type: "5" });
    // Only 2 consecutive throws since the reset — still subscribed.
    expect(channel.subscribers.size).toBe(1);
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
