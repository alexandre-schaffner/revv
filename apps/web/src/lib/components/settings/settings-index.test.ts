import { describe, expect, test } from "bun:test";
import { SETTINGS_INDEX, SETTINGS_PANES, searchSettings } from "./settings-index";

describe("settings index", () => {
  test("row ids are unique, so a search hit anchors to exactly one row", () => {
    const ids = SETTINGS_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every entry names a pane that exists", () => {
    for (const entry of SETTINGS_INDEX) expect(SETTINGS_PANES[entry.pane]).toBeDefined();
  });
});

describe("searchSettings", () => {
  test("an empty or blank query matches nothing", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  test("a label hit ranks first and carries its match range", () => {
    const [first] = searchSettings("wrap");
    expect(first?.entry.id).toBe("diff-wrap");
    expect(first?.match).toEqual({ start: 0, end: 4 });
  });

  test("is case-insensitive", () => {
    expect(searchSettings("WRAP")[0]?.entry.id).toBe("diff-wrap");
  });

  test("label hits outrank keyword-only hits", () => {
    const hits = searchSettings("theme");
    const firstKeywordOnly = hits.findIndex((h) => h.match === null);
    const lastLabel = hits.findLastIndex((h) => h.match !== null);
    expect(lastLabel).toBeLessThan(firstKeywordOnly === -1 ? Infinity : firstKeywordOnly);
  });

  test("keywords find rows whose label doesn't mention the term", () => {
    const hit = searchSettings("nightly").find((h) => h.entry.id === "update-channel");
    expect(hit?.match).toBeNull();
  });
});
