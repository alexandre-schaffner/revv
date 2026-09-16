import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatIssues, SCHEMA_VERSION, safeParseGraphDoc } from "@coldtea/pr-lens-schema";
import { toGraphDocInput } from "@revv/shared";

// ── Prompt ↔ schema drift ────────────────────────────────────────────────────
//
// `walkthrough-system-common.md` hand-transcribes the PR Lens document contract
// for the agent: the field list, five enum sets, the id regex, the cardinality
// bounds. The authority for all of it is `@coldtea/pr-lens-schema`, a pre-1.0
// dependency whose enums will move.
//
// Nothing fails when it does. `safeParseGraphDoc` rejects the agent's document,
// the web app's `renderPrLens` returns `{ error }`, and the reader gets a
// fallback box where a diagram should be — a headline feature degrading
// silently, in production, on a patch bump. This test makes a schema change
// break CI instead: the prompt's own worked examples are parsed with the exact
// wrapping both runtime paths use.
//
// It lives beside the prompt it reads. The same assertions were briefly in
// `apps/web`, reaching across the monorepo with four `..` segments into a
// package `apps/web` does not depend on; moving either file broke the test with
// an ENOENT rather than a failure that said anything.
//
// When this fails, the prompt is what's stale. Fix the markdown, not the test.

const PROMPT = join(import.meta.dir, "walkthrough-system-common.md");

/**
 * Every ```prlens fenced body in the prompt, in document order.
 *
 * A local regex rather than `prLensFenceBodies`: the examples are shown inside
 * ````markdown wrappers, and that extractor deliberately skips nested fences so
 * a documented example is never validated as a real diagram. Here the nesting
 * is exactly what we want to reach through.
 */
function promptExamples(): string[] {
  const markdown = readFileSync(PROMPT, "utf8");
  return [...markdown.matchAll(/```prlens\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
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
