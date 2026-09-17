import { describe, expect, it } from "bun:test";
import { prLensDiagramError, prLensFenceBodies } from "./prlens-doc";

// The prompt's own architecture example, which the web-side drift test already
// parses against the live schema. Used here as the "renderable" baseline so a
// schema bump breaks the negative cases too, not just the positive ones.
const VALID_DOC = `{
  "title": "Auth check moves ahead of the loader",
  "lenses": ["architecture"],
  "lanes": [
    { "id": "http", "label": "HTTP" },
    { "id": "domain", "label": "Domain" }
  ],
  "nodes": [
    { "id": "handle-request", "label": "handleRequest", "kind": "route", "delta": "modified", "lane": "http" },
    { "id": "load-user", "label": "loadUser", "kind": "function", "delta": "unchanged", "lane": "domain" }
  ]
}`;

/** A ```prlens fence wrapped in prose, the way an agent writes one. */
function fence(body: string, lang = "prlens"): string {
  return `Some prose first.\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\nAnd prose after.`;
}

describe("prLensFenceBodies", () => {
  it("finds nothing in markdown without a diagram", () => {
    expect(prLensFenceBodies("Plain prose with `inline code`.")).toEqual([]);
    expect(prLensFenceBodies("```ts\nconst x = 1;\n```")).toEqual([]);
  });

  it("accepts both spellings of the language tag", () => {
    expect(prLensFenceBodies(fence(VALID_DOC))).toHaveLength(1);
    expect(prLensFenceBodies(fence(VALID_DOC, "pr-lens"))).toHaveLength(1);
    expect(prLensFenceBodies(fence(VALID_DOC, "PrLens"))).toHaveLength(1);
  });

  it("reads a fence written with tildes", () => {
    expect(prLensFenceBodies(`~~~prlens\n${VALID_DOC}\n~~~`)).toHaveLength(1);
  });

  it("reads a fence whose newlines arrived as literal escapes", () => {
    // `renderMarkdown` normalizes these before parsing, so a diagram written
    // this way still renders — and so must still be validated.
    const escaped = `Prose.\\n\`\`\`prlens\\n${VALID_DOC.replace(/\n/g, "\\n")}\\n\`\`\`\\n`;
    expect(prLensFenceBodies(escaped)).toHaveLength(1);
  });

  it("ignores a prlens fence nested inside a longer fence", () => {
    // This is how the walkthrough prompt shows its own examples. marked renders
    // the outer fence as sample text, so the inner body is never a diagram.
    const nested = "````markdown\n```prlens\n{ not a document }\n```\n````";
    expect(prLensFenceBodies(nested)).toEqual([]);
  });

  it("finds every top-level fence in order", () => {
    const two = `${fence(VALID_DOC)}\n\n${fence('{"title":"second"}')}`;
    const bodies = prLensFenceBodies(two);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("second");
  });
});

describe("prLensDiagramError", () => {
  it("passes a document the renderer would accept", () => {
    expect(prLensDiagramError(fence(VALID_DOC), "markdown block content")).toBeNull();
  });

  it("passes markdown with no diagram at all", () => {
    expect(prLensDiagramError("Just prose.", "markdown block content")).toBeNull();
  });

  it("rejects an invented node kind, naming the field and the allowed values", () => {
    const error = prLensDiagramError(
      fence(VALID_DOC.replace('"kind": "route"', '"kind": "migration"')),
      "markdown block content",
    );
    expect(error).toContain("nodes[0].kind");
    expect(error).toContain("datastore");
    expect(error).toContain("markdown block content");
  });

  it("rejects a reference to an id that is not declared", () => {
    const dangling = VALID_DOC.replace('"lane": "domain"', '"lane": "nowhere"');
    expect(prLensDiagramError(fence(dangling), "code block annotation")).toContain(
      "code block annotation",
    );
  });

  it("rejects a body that is not JSON", () => {
    expect(prLensDiagramError(fence("{ title: nope }"), "markdown block content")).toContain(
      "not valid JSON",
    );
  });

  it("rejects a body that is JSON but not an object", () => {
    expect(prLensDiagramError(fence("[]"), "markdown block content")).toContain(
      "not a JSON object",
    );
  });

  it("says which diagram failed when a block holds several", () => {
    const error = prLensDiagramError(
      `${fence(VALID_DOC)}\n\n${fence('{"title":"broken"}')}`,
      "markdown block content",
    );
    expect(error).toContain("diagram 2 of 2");
  });
});
