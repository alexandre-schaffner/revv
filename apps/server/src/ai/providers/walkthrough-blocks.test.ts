import { describe, expect, it } from "bun:test";
import {
  artifactInteractivityWarning,
  artifactLayoutWarning,
  artifactThemingWarning,
  type BlockVariantInput,
  blockContentError,
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

describe("artifactInteractivityWarning", () => {
  it("returns null when the artifact has a control the reader can drive", () => {
    expect(
      artifactInteractivityWarning(artifact(`<body><button id="step">Step</button></body>`)),
    ).toBeNull();
    expect(
      artifactInteractivityWarning(
        artifact(
          `<body><div id="row"></div><script>row.addEventListener("click", next)</script></body>`,
        ),
      ),
    ).toBeNull();
    expect(
      artifactInteractivityWarning(
        artifact(`<body><label><input type="checkbox" /> With the guard</label></body>`),
      ),
    ).toBeNull();
  });

  it("warns when the artifact is a static picture", () => {
    expect(
      artifactInteractivityWarning(
        artifact(`<body><div class="row">step 1</div><div class="row">step 2</div></body>`),
      ),
    ).toContain("no interactive control");
  });

  it("returns null for non-artifact variants", () => {
    expect(artifactInteractivityWarning({ markdown: { content: "1. step one" } })).toBeNull();
  });
});

describe("artifactLayoutWarning", () => {
  it("returns null for an artifact that inherits the baseline type and reserves nothing", () => {
    expect(
      artifactLayoutWarning(
        artifact(`<style>.row { font-size: 12px; padding: 3px 8px; }</style><button>Step</button>`),
      ),
    ).toBeNull();
  });

  it("warns when type is sized above the 13px ceiling", () => {
    expect(artifactLayoutWarning(artifact(`<style>.title { font-size: 15px; }</style>`))).toContain(
      "font-size: 15px",
    );
    expect(artifactLayoutWarning(artifact(`<style>.title { font-size: 1rem; }</style>`))).toContain(
      "font-size: 1rem",
    );
    expect(
      artifactLayoutWarning(artifact(`<style>.title { font-size: 13px; }</style>`)),
    ).toBeNull();
    expect(artifactLayoutWarning(artifact(`<style>.n { font-size: 0.8rem; }</style>`))).toBeNull();
  });

  it("warns about height reserved for content that has not rendered", () => {
    expect(
      artifactLayoutWarning(artifact(`<style>.verdict { min-height: 48px; }</style>`)),
    ).toContain("min-height: 48px");
    expect(artifactLayoutWarning(artifact(`<style>.trace { height: 240px; }</style>`))).toContain(
      "height: 240px",
    );
  });

  it("ignores hairline min-heights and control-sized fixed heights", () => {
    expect(artifactLayoutWarning(artifact(`<style>.rule { min-height: 1px; }</style>`))).toBeNull();
    expect(artifactLayoutWarning(artifact(`<style>.bar { height: 24px; }</style>`))).toBeNull();
    expect(
      artifactLayoutWarning(artifact(`<style>.wrap { max-height: 300px; }</style>`)),
    ).toBeNull();
  });

  it("warns about a native select", () => {
    expect(
      artifactLayoutWarning(artifact(`<select><option>admin tab</option></select>`)),
    ).toContain("<select>");
  });

  it("returns null for non-artifact variants", () => {
    expect(artifactLayoutWarning({ markdown: { content: "font-size: 32px" } })).toBeNull();
  });
});

describe("blockContentError", () => {
  const DIAGRAM = [
    "```prlens",
    '{ "title": "T", "lenses": ["architecture"],',
    '  "lanes": [{ "id": "http", "label": "HTTP" }],',
    '  "nodes": [{ "id": "n", "label": "n", "kind": "KIND", "delta": "added", "lane": "http" }] }',
    "```",
  ].join("\n");

  it("rejects an empty payload before it looks at diagrams", () => {
    expect(blockContentError({ markdown: { content: "   " } })).toContain("non-empty content");
  });

  it("accepts a markdown block whose diagram renders", () => {
    expect(
      blockContentError({ markdown: { content: DIAGRAM.replace("KIND", "route") } }),
    ).toBeNull();
  });

  it("rejects a markdown block whose diagram the renderer would reject", () => {
    expect(
      blockContentError({ markdown: { content: DIAGRAM.replace("KIND", "migration") } }),
    ).toContain("markdown block content");
  });

  it("checks the annotation beside a code block, not only prose blocks", () => {
    expect(
      blockContentError({
        code: {
          file_path: "a.ts",
          start_line: 1,
          end_line: 2,
          language: "ts",
          content: "const a = 1;",
          annotation: DIAGRAM.replace("KIND", "migration"),
          annotation_position: "right",
        },
      }),
    ).toContain("code block annotation");
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
