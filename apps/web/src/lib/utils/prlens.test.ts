import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatIssues, SCHEMA_VERSION, safeParseGraphDoc } from "@coldtea/pr-lens-schema";
import { toGraphDocInput } from "@revv/shared";
import { renderPrLens } from "./prlens.svelte";

// ── Prompt ↔ schema drift ────────────────────────────────────────────────────
//
// `walkthrough-system-common.md` hand-transcribes the PR Lens document
// contract for the agent: the field list, five enum sets, the id regex, the
// cardinality bounds. The authority for all of it is `@coldtea/pr-lens-schema`,
// a pre-1.0 dependency whose enums will move.
//
// Nothing fails when it does. `safeParseGraphDoc` rejects the agent's document,
// `renderPrLens` returns `{ error }`, and the reader gets a fallback box where a
// diagram should be — a headline feature degrading silently, in production, on
// a patch bump. This test makes a schema change break CI instead: the prompt's
// own worked examples are parsed with the exact wrapping the runtime uses.
//
// When this fails, the prompt is what's stale. Fix the markdown, not the test.

const PROMPT = join(
  import.meta.dir,
  "../../../../server/src/ai/prompts/walkthrough-system-common.md",
);

/** Every ```prlens fenced body in the prompt, in document order. */
function promptExamples(): string[] {
  const markdown = readFileSync(PROMPT, "utf8");
  const fences = markdown.matchAll(/```prlens\n([\s\S]*?)```/g);
  return [...fences].map((match) => match[1] ?? "");
}

describe("the prompt's prlens examples", () => {
  const examples = promptExamples();

  it("are actually present, so a silent zero-example pass is impossible", () => {
    // The prompt documents two lenses and shows one example of each.
    expect(examples.length).toBe(2);
  });

  it.each(
    examples.map((body, index) => [index, body] as const),
  )("example %i parses under the current schema", (_index, body) => {
    const parsed = safeParseGraphDoc(toGraphDocInput(JSON.parse(body), SCHEMA_VERSION));
    // Surface the schema's own complaint rather than a bare `false`, so the
    // failure names the field that moved.
    const reason = parsed.ok ? "" : formatIssues(parsed.error.issues);
    expect(reason).toBe("");
    expect(parsed.ok).toBe(true);
  });

  it("declare exactly one lens each, as the prompt instructs", () => {
    for (const body of examples) {
      expect(JSON.parse(body).lenses).toHaveLength(1);
    }
  });
});

// ── Rendered-SVG guarantees ──────────────────────────────────────────────────
//
// Both of these are regex transforms over the renderer's output, so they are
// tested against a real render of a real document rather than a handcrafted
// string — the shape they depend on belongs to the package, not to us, and a
// package bump is exactly when they'd quietly stop matching.

const DATA_FLOW = promptExamples()[1] ?? "";

describe("renderPrLens", () => {
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
