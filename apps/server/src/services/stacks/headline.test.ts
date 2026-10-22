import { describe, expect, test } from "bun:test";
import { parseStackHeadline } from "../../ai/providers/stack-headline";
import { firstSentence, headlineFromTitles } from "./headline";

describe("headlineFromTitles", () => {
  test("a shared conventional scope names the stack", () => {
    expect(
      headlineFromTitles([
        "feat(pr-stacks): data",
        "fix(pr-stacks): rail",
        "feat(pr-stacks)!: merge",
      ]),
    ).toBe("Pr stacks");
  });

  test("shared leading words name the stack", () => {
    expect(headlineFromTitles(["Billing retries: schema", "Billing retries: worker"])).toBe(
      "Billing retries",
    );
  });

  test("otherwise the top layer's title names where it ends up", () => {
    expect(headlineFromTitles(["feat: add table", "feat(api): expose merge plan"])).toBe(
      "Expose merge plan",
    );
  });
});

describe("parseStackHeadline", () => {
  test("reads fenced JSON and normalises punctuation", () => {
    expect(
      parseStackHeadline(
        'Sure:\n```json\n{"headline": "Stack merges.", "gist": "Merges a stack bottom-up"}\n```',
      ),
    ).toEqual({ headline: "Stack merges", gist: "Merges a stack bottom-up." });
  });

  test("rejects half an answer", () => {
    expect(parseStackHeadline('{"headline": "x"}')).toBeNull();
  });
});

describe("firstSentence", () => {
  test("drops markdown and stops at the first full stop", () => {
    expect(firstSentence("**Adds** stacked review. Then merges.")).toBe("Adds stacked review.");
  });
});
