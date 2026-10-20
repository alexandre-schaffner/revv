import { describe, expect, it } from "bun:test";
import { singleFlight } from "./single-flight";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("singleFlight", () => {
  it("joins a read already in flight", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const reads = singleFlight<string>(async (_key, arg) => {
      calls.push(arg);
      await gate.promise;
    });
    const a = reads.run("k", "first");
    const b = reads.run("k", "second");
    expect(b).toBe(a);
    gate.resolve();
    await a;
    expect(calls).toEqual(["first"]);
  });

  it("reads again after the in-flight read when a rerun arrives mid-flight", async () => {
    const gates = [deferred(), deferred()];
    const calls: string[] = [];
    const reads = singleFlight<string>(async (_key, arg) => {
      const gate = gates[calls.length];
      calls.push(arg);
      await gate?.promise;
    });
    const first = reads.run("k", "a");
    const second = reads.rerun("k", "b");
    reads.rerun("k", "c");
    gates[0]?.resolve();
    await Promise.resolve();
    gates[1]?.resolve();
    await second;
    await first;
    // One more read, with the latest argument, not one per rerun.
    expect(calls).toEqual(["a", "c"]);
  });

  it("starts fresh once the previous read settled", async () => {
    let n = 0;
    const reads = singleFlight<void>(async () => {
      n += 1;
    });
    await reads.run("k");
    await reads.rerun("k");
    expect(n).toBe(2);
  });
});
