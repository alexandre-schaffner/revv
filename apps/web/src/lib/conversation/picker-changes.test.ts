import { describe, expect, it } from "bun:test";
import { pickerChanges } from "./picker-changes";

describe("picker edits during a conversation refresh", () => {
  it("leaves a remotely added selection intact when closed without edits", () => {
    const opening = new Map([["alice", "alice"]]);
    const refreshed = new Map([...opening, ["bob", "bob"]]);
    const delta = pickerChanges(opening, new Set(opening.keys()));
    for (const item of delta.removed) refreshed.delete(item);
    expect(delta).toEqual({ addedKeys: [], removed: [] });
    expect([...refreshed.keys()]).toEqual(["alice", "bob"]);
  });

  it("emits only explicit additions and removals against the opening selection", () => {
    const opening = new Map([["alice", { login: "alice" }]]);
    const draft = new Set(["carol"]);
    expect(pickerChanges(opening, draft)).toEqual({
      addedKeys: ["carol"],
      removed: [{ login: "alice" }],
    });
  });

  it("retains an explicit addition even when a refresh removed an opening selection", () => {
    const opening = new Map([["alice", "alice"]]);
    expect(pickerChanges(opening, new Set(["alice", "carol"]))).toEqual({
      addedKeys: ["carol"],
      removed: [],
    });
  });
});
