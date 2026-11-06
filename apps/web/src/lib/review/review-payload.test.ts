import { describe, expect, it } from "bun:test";
import type { WalkthroughIssue } from "@revv/shared";
import { reviewBody } from "./review-payload";

describe("reviewBody", () => {
  const issue = (overrides: Partial<WalkthroughIssue>): WalkthroughIssue => ({
    id: "i",
    severity: "warning",
    title: "Title",
    description: "Why.",
    blockIds: [],
    ...overrides,
  });

  it("is empty without issues", () => {
    expect(reviewBody([])).toBe("");
  });

  it("lists issues with severity tags and locations", () => {
    expect(
      reviewBody([
        issue({ severity: "critical", filePath: "a.ts", startLine: 1, endLine: 4 }),
        issue({ severity: "info", filePath: "b.ts" }),
        issue({}),
      ]),
    ).toBe(
      [
        "### Walkthrough issues",
        "- `[CRITICAL]` **Title** (`a.ts:1–4`)\n  Why.",
        "- `[INFO]` **Title** (`b.ts`)\n  Why.",
        "- `[WARNING]` **Title**\n  Why.",
      ].join("\n\n"),
    );
  });
});
