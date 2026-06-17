import { describe, expect, it } from "bun:test";
import {
  artifactThemingWarning,
  type BlockVariantInput,
  buildBlock,
  normalizeDiffPatch,
} from "./walkthrough-blocks";

// A valid unified-diff hunk header must carry `@@ -a,b +c,d @@` ranges. The
// regex models do not always produce — they emit a bare `@@` — which parses
// into zero hunks and renders a blank panel. normalizeDiffPatch repairs that.
const VALID_HEADER = /^@@ -\d+,\d+ \+\d+,\d+ @@/m;

function artifact(html: string): BlockVariantInput {
  return {
    artifact: {
      html,
      annotation: null,
      annotation_position: "right",
    },
  };
}

describe("artifactThemingWarning", () => {
  it("returns null for artifacts styled with injected theme variables", () => {
    expect(
      artifactThemingWarning(
        artifact(`
          <style>
            body {
              color: var(--color-accent);
              background: var(--color-bg-primary);
              font-family: var(--font-mono);
              border-radius: var(--radius-card);
            }
          </style>
        `),
      ),
    ).toBeNull();
  });

  it("does not flag selectors, fragment hrefs, or SVG paint refs", () => {
    expect(
      artifactThemingWarning(
        artifact(`
          <style>
            #panel { color: var(--color-fg-primary); }
          </style>
          <a href="#section">Jump</a>
          <svg><rect fill="url(#grad)" /></svg>
        `),
      ),
    ).toBeNull();
  });

  it("flags hex color literals in CSS value position", () => {
    expect(artifactThemingWarning(artifact(`<style>body { color: #fff; }</style>`))).toContain(
      "hex color literal",
    );
  });

  it("flags functional color notations", () => {
    const examples = ["rgba(0,0,0,.5)", "oklch(60% 0.1 180)", "hsl(0 0% 100%)", "hwb(90 10% 10%)"];

    for (const value of examples) {
      expect(
        artifactThemingWarning(artifact(`<style>body { background: ${value}; }</style>`)),
      ).toContain("rgb()/hsl()/oklch() color");
    }
  });

  it("flags literal font-family declarations", () => {
    expect(
      artifactThemingWarning(artifact(`<style>body { font-family: "Inter", sans-serif; }</style>`)),
    ).toContain("literal font-family");
  });

  it("allows theme font variables and generic-only font-family declarations", () => {
    expect(
      artifactThemingWarning(artifact(`<style>body { font-family: var(--font-sans); }</style>`)),
    ).toBeNull();
    expect(
      artifactThemingWarning(artifact(`<style>code { font-family: monospace; }</style>`)),
    ).toBeNull();
  });

  it("returns null for non-artifact variants", () => {
    expect(
      artifactThemingWarning({
        markdown: { content: "This prose mentions #fff and rgba(0,0,0,.5)." },
      }),
    ).toBeNull();
  });
});

describe("normalizeDiffPatch", () => {
  it("synthesizes a header for a bare `@@` hunk (the blank-panel bug)", () => {
    // The exact shape seen in PR 1105: bare `@@`, one removal, three additions.
    const patch = ["@@", "-const a = old();", "+// note", "+// note 2", "+const a = new();"].join(
      "\n",
    );
    const out = normalizeDiffPatch(patch);
    expect(out).toMatch(VALID_HEADER);
    expect(out).toContain("@@ -1,1 +1,3 @@");
    // Body is preserved verbatim.
    expect(out).toContain("-const a = old();");
    expect(out).toContain("+const a = new();");
  });

  it("synthesizes a header when the patch has none at all", () => {
    const patch = ["-removed line", "+added line", " context line"].join("\n");
    const out = normalizeDiffPatch(patch);
    expect(out.startsWith("@@ ")).toBe(true);
    // 1 removed + 1 context = old count 2; 1 added + 1 context = new count 2.
    expect(out).toContain("@@ -1,2 +1,2 @@");
  });

  it("uses git's -0,0 convention for a pure insertion", () => {
    const out = normalizeDiffPatch(["@@", "+only an addition"].join("\n"));
    expect(out).toContain("@@ -0,0 +1,1 @@");
  });

  it("leaves a well-formed patch unchanged and is idempotent", () => {
    const valid = ["@@ -10,2 +10,3 @@", " context", "-old", "+new1", "+new2"].join("\n");
    expect(normalizeDiffPatch(valid)).toBe(valid);
    expect(normalizeDiffPatch(normalizeDiffPatch(valid))).toBe(valid);
  });

  it("repairs only malformed headers in a multi-hunk patch", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-a", "+b", "@@", "-c", "+d"].join("\n");
    const out = normalizeDiffPatch(patch);
    expect(out).toContain("@@ -1,1 +1,1 @@"); // valid one kept
    expect(out).toContain("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-c\n+d");
  });

  it("is applied when buildBlock constructs a diff block", () => {
    const block = buildBlock("b1", 0, 0, {
      diff: {
        file_path: "a.ts",
        patch: ["@@", "-x", "+y"].join("\n"),
        annotation: null,
        annotation_position: "left",
      },
    });
    expect(block?.type).toBe("diff");
    if (block?.type === "diff") expect(block.patch).toMatch(VALID_HEADER);
  });
});
