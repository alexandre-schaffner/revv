import { describe, expect, test } from "bun:test";
import { defineSettingsPane, searchSettings } from "./settings-panes";

const icon = (() => {}) as never;

const general = defineSettingsPane({
  id: "general",
  title: "General",
  description: "",
  icon,
  rows: {
    theme: { label: "Theme", keywords: ["appearance", "dark"] },
    diffTheme: { label: "Diff theme", keywords: ["syntax"] },
    wrap: { label: "Wrap long lines", keywords: ["soft wrap"] },
  },
});

const updates = defineSettingsPane({
  id: "updates",
  title: "Updates",
  description: "",
  icon,
  rows: { channel: { label: "Release channel", keywords: ["nightly", "stable"] } },
});

const panes = [general, updates];

describe("defineSettingsPane", () => {
  test("anchors each row under its pane, so ids can't collide across panes", () => {
    expect(general.rows.theme.anchor).toBe("general.theme");
    expect(updates.rows.channel.anchor).toBe("updates.channel");
  });
});

describe("searchSettings", () => {
  test("an empty or blank query matches nothing", () => {
    expect(searchSettings(panes, "")).toEqual([]);
    expect(searchSettings(panes, "   ")).toEqual([]);
  });

  test("a label hit ranks first and carries its match range", () => {
    const [first] = searchSettings(panes, "wrap");
    expect(first?.row.anchor).toBe("general.wrap");
    expect(first?.match).toEqual({ start: 0, end: 4 });
  });

  test("is case-insensitive", () => {
    expect(searchSettings(panes, "WRAP")[0]?.row.anchor).toBe("general.wrap");
  });

  test("label hits outrank keyword-only hits", () => {
    const hits = searchSettings(panes, "theme");
    expect(hits.map((h) => h.row.anchor)).toEqual(["general.theme", "general.diffTheme"]);
  });

  test("keywords find rows whose label doesn't mention the term", () => {
    const [hit] = searchSettings(panes, "nightly");
    expect(hit?.row.anchor).toBe("updates.channel");
    expect(hit?.match).toBeNull();
  });

  test("a pane title finds its rows last", () => {
    const hits = searchSettings(panes, "updates");
    expect(hits.map((h) => h.row.anchor)).toEqual(["updates.channel"]);
  });
});
