import { describe, expect, it } from "bun:test";
import { shallowEntryEqual, updateEntryInMap } from "./walkthrough-entry-equal";

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

  it("does not write the entry map for a no-op updater", () => {
    class CountingMap<K, V> extends Map<K, V> {
      setCount = 0;

      override set(key: K, value: V): this {
        this.setCount += 1;
        return super.set(key, value);
      }
    }

    const entries = new CountingMap<string, { doneReceived: boolean; superseded: boolean }>();
    const entry = { doneReceived: false, superseded: false };
    entries.set("pr-1", entry);
    entries.setCount = 0;

    const result = updateEntryInMap(entries, "pr-1", (draft) => {
      if (!draft.doneReceived || draft.superseded) return;
      draft.superseded = true;
    });

    expect(result).toBe("unchanged");
    expect(entries.setCount).toBe(0);
    expect(entries.get("pr-1")).toBe(entry);
  });

  it("rejects in-place nested mutations instead of treating them as no-ops", () => {
    const entries = new Map<string, { blocks: Array<{ id: string }> }>();
    entries.set("pr-1", { blocks: [{ id: "1" }] });

    expect(() =>
      updateEntryInMap(entries, "pr-1", (draft) => {
        draft.blocks.push({ id: "2" });
      }),
    ).toThrow(/in-place nested mutation/);
  });
});
