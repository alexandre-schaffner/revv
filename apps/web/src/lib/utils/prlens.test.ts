import { describe, expect, it } from "bun:test";
import { renderPrLens } from "./prlens.svelte";

// ── Rendered-SVG guarantees ──────────────────────────────────────────────────
//
// `stripAnimation` and `themeStyleBlock` are regex transforms over the
// renderer's output, so they are tested against a real render of a real
// document rather than a handcrafted SVG string — the shape they depend on
// belongs to the package, not to us, and a package bump is exactly when they
// would quietly stop matching.
//
// The document is a copy of the `data-flow` worked example in
// `walkthrough-system-common.md`. That the prompt's examples still satisfy the
// schema is asserted next to the prompt itself, in
// `apps/server/src/ai/prompts/prlens-examples.test.ts`; here the document is
// only a fixture that has to animate and carry a stylesheet.

const DATA_FLOW = JSON.stringify({
  title: "Review context is fetched once per session",
  lenses: ["data-flow"],
  lanes: [{ id: "app", label: "App" }],
  nodes: [
    { id: "client", label: "ReviewPanel", kind: "ui", delta: "unchanged", lane: "app" },
    { id: "server", label: "GET /api/review", kind: "route", delta: "modified", lane: "app" },
    { id: "cache", label: "sessionCache", kind: "cache", delta: "added", lane: "app" },
  ],
  flows: [
    {
      id: "fetch-context",
      title: "Fetching review context",
      participants: [{ node: "client" }, { node: "server" }, { node: "cache" }],
      messages: [
        {
          id: "req",
          from: "client",
          to: "server",
          label: "GET /api/review",
          kind: "sync",
          delta: "unchanged",
        },
        {
          id: "lookup",
          from: "server",
          to: "cache",
          label: "read(prId)",
          kind: "sync",
          delta: "added",
        },
        {
          id: "hit",
          from: "cache",
          to: "server",
          label: "cached context",
          kind: "return",
          delta: "added",
        },
        {
          id: "res",
          from: "server",
          to: "client",
          label: "200 context",
          kind: "return",
          delta: "unchanged",
        },
      ],
    },
  ],
});

describe("renderPrLens", () => {
  it("renders the fixture at all, so every assertion below has a premise", async () => {
    const result = await renderPrLens(DATA_FLOW, "light", true);
    // Name the schema's complaint rather than failing on a bare `false`: if the
    // package's enums move, this is the test that says which field did.
    expect("error" in result ? result.error : "").toBe("");
  });

  it("emits SMIL when motion is allowed", async () => {
    const result = await renderPrLens(DATA_FLOW, "light", true);
    expect("svg" in result).toBe(true);
    if (!("svg" in result)) return;
    // Premise check: if the renderer ever stops animating, the reduced-motion
    // assertion below would pass for the wrong reason.
    expect(result.svg).toContain("<animate");
  });

  it("strips every looping animation under reduced motion", async () => {
    const result = await renderPrLens(DATA_FLOW, "light", false);
    expect("svg" in result).toBe(true);
    if (!("svg" in result)) return;
    expect(result.svg).not.toContain("<animate");
    expect(result.svg).not.toContain("repeatCount");
    // The structure the dots travelled over must survive.
    expect(result.svg).toContain("<path");
  });

  it("confines the SVG's own stylesheet to the diagram", async () => {
    const result = await renderPrLens(DATA_FLOW, "light", false);
    expect("svg" in result).toBe(true);
    if (!("svg" in result)) return;

    const css = /<style>([\s\S]*?)<\/style>/.exec(result.svg)?.[1] ?? "";
    expect(css).not.toBe("");

    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => (m[1] ?? "").trim());
    expect(selectors.length).toBeGreaterThan(10);
    // Every rule — including the bare `text{…}` that would otherwise restyle
    // every inline SVG on the page — is scoped.
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim().startsWith(".prlens-diagram ")).toBe(true);
      }
    }
  });

  it("returns an error rather than rejecting on a malformed document", async () => {
    expect(await renderPrLens("{ not json", "light", true)).toHaveProperty("error");
    expect(await renderPrLens("[]", "light", true)).toHaveProperty("error");
    expect(await renderPrLens('{"title":"no lenses"}', "light", true)).toHaveProperty("error");
  });
});
