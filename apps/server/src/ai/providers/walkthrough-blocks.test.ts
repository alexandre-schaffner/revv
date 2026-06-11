import { describe, expect, it } from "bun:test";
import { artifactThemingWarning, type BlockVariantInput } from "./walkthrough-blocks";

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
