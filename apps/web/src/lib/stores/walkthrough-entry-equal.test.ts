import { describe, expect, it } from "bun:test";
import { shallowEntryEqual } from "./walkthrough-entry-equal";

// Regression guard for the new-commit freeze: `updateEntry` relies on this
// detecting a no-op update so it can skip the reactive `store.entries` write.
// If it ever reports a genuine no-op as "changed", the self-invalidation loop
// (`effect_update_depth_exceeded`) returns.

describe("shallowEntryEqual", () => {
  it("treats a same-shape clone as unchanged (the no-op case)", () => {
    const arr = [1, 2, 3];
    const a = { superseded: false, isStreaming: true, blocks: arr, summary: null };
    const b = { ...a };
    // An updater that early-returns leaves the clone byte-identical.
    expect(shallowEntryEqual(a, b)).toBe(true);
  });

  it("returns true for the same reference", () => {
    const a = { superseded: false, blocks: [] };
    expect(shallowEntryEqual(a, a)).toBe(true);
  });

  it("detects a changed scalar field", () => {
    const a = { superseded: false, isStreaming: true };
    const b = { ...a, superseded: true };
    expect(shallowEntryEqual(a, b)).toBe(false);
  });

  it("detects a replaced array/object reference (immutable update)", () => {
    const a = { blocks: [{ id: "1" }], results: { x: 1 } };
    expect(shallowEntryEqual(a, { ...a, blocks: [...a.blocks] })).toBe(false);
    expect(shallowEntryEqual(a, { ...a, results: { ...a.results } })).toBe(false);
  });

  it("does NOT detect an in-place nested mutation (why updaters must be immutable)", () => {
    const a = { blocks: [{ id: "1" }] };
    const b = { ...a };
    // Same array reference mutated in place — shallow equality can't see it.
    // This documents the invariant: store updaters replace references, never
    // mutate nested state in place.
    b.blocks.push({ id: "2" });
    expect(shallowEntryEqual(a, b)).toBe(true);
  });
});
