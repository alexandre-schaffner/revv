import { describe, expect, it } from "bun:test";
import { type Answer, createResource } from "./resource";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("createResource", () => {
  it("joins an ask already in flight", async () => {
    const gate = deferred<Answer<string>>();
    let calls = 0;
    const r = createResource<void, string>({
      fetch: () => {
        calls += 1;
        return gate.promise;
      },
    });
    const a = r.load("k", undefined);
    const b = r.load("k", undefined);
    expect(r.entry("k").request.status).toBe("loading");
    gate.resolve({ status: "ok", data: "x" });
    expect(await a).toEqual({ status: "ok", data: "x" });
    expect(await b).toEqual({ status: "ok", data: "x" });
    expect(calls).toBe(1);
  });

  it("serves a fresh answer, then asks again once it is stale", async () => {
    let calls = 0;
    const r = createResource<void, number>({
      freshForMs: 20,
      fetch: async () => ({ status: "ok", data: ++calls }),
    });
    await r.load("k", undefined);
    await r.load("k", undefined);
    expect(calls).toBe(1);
    await tick(25);
    await r.load("k", undefined);
    expect(calls).toBe(2);
    expect(r.data("k")).toBe(2);
  });

  it("re-asks a pending answer on the retry schedule, then gives up", async () => {
    let calls = 0;
    const r = createResource<void, string>({
      retryDelaysMs: [1, 1],
      gaveUpError: "never ready",
      fetch: async () => {
        calls += 1;
        return { status: "pending" };
      },
    });
    await r.load("k", undefined);
    expect(r.entry("k").loading).toBe(true);
    await tick(20);
    expect(calls).toBe(3);
    expect(r.entry("k")).toMatchObject({
      loading: false,
      gaveUp: true,
      request: { status: "error", error: "never ready" },
    });
  });

  it("keeps pending data on screen and gives up with it", async () => {
    const r = createResource<void, string>({
      retryDelaysMs: [],
      fetch: async () => ({ status: "pending", data: "partial" }),
    });
    await r.load("k", undefined);
    expect(r.entry("k")).toMatchObject({
      gaveUp: true,
      request: { status: "ok", data: "partial" },
    });
  });

  it("drops the answer of a superseded version", async () => {
    const first = deferred<Answer<string>>();
    const answers = [first.promise, Promise.resolve<Answer<string>>({ status: "ok", data: "v2" })];
    const r = createResource<void, string>({
      fetch: () => answers.shift() as Promise<Answer<string>>,
    });
    void r.load("k", undefined, "v1");
    await r.load("k", undefined, "v2");
    first.resolve({ status: "ok", data: "v1" });
    await tick();
    expect(r.data("k")).toBe("v2");
  });

  it("keeps data on error only when asked to", async () => {
    let fail = false;
    const make = (keepDataOnError: boolean) =>
      createResource<void, string>({
        keepDataOnError,
        fetch: async () =>
          fail ? { status: "error", error: "down" } : { status: "ok", data: "x" },
      });
    const keep = make(true);
    const replace = make(false);
    fail = false;
    await keep.load("k", undefined);
    await replace.load("k", undefined);
    fail = true;
    await keep.load("k", undefined);
    await replace.load("k", undefined);
    expect(keep.entry("k").request).toEqual({ status: "ok", data: "x" });
    expect(replace.entry("k").request).toEqual({ status: "error", error: "down" });
  });

  it("refresh during an ask asks once more after it lands", async () => {
    const gate = deferred<Answer<number>>();
    let calls = 0;
    const r = createResource<void, number>({
      fetch: () => {
        calls += 1;
        return calls === 1 ? gate.promise : Promise.resolve({ status: "ok", data: calls });
      },
    });
    void r.load("k", undefined);
    void r.refresh("k", undefined);
    void r.refresh("k", undefined);
    gate.resolve({ status: "ok", data: 1 });
    await tick();
    await tick();
    expect(calls).toBe(2);
    expect(r.data("k")).toBe(2);
  });

  it("reset forgets every key and blocks late writes", async () => {
    const gate = deferred<Answer<string>>();
    const r = createResource<void, string>({ fetch: () => gate.promise });
    void r.load("k", undefined);
    r.reset();
    gate.resolve({ status: "ok", data: "late" });
    await tick();
    expect(r.entry("k").request.status).toBe("idle");
  });
});
