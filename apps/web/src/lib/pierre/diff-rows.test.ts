import { describe, expect, it } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { diffRowAt, diffRowCount, diffRowRange, rowIndexAt, rowIndexForNewLine } from "./diff-rows";

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,5 @@
 keep10
-old11
-old12
+new11
+new12
+new13
 keep13
@@ -40,2 +41,2 @@
 keep40
-old41
+new42
`;

function parsed() {
  const file = parsePatchFiles(PATCH)[0]?.files[0];
  if (!file) throw new Error("patch did not parse");
  return file;
}

/** Index of the first hunk's first row: Pierre counts the 9 collapsed lines above it. */
const H = 9;

describe("diffRowAt", () => {
  it("walks context, then deletions, then additions", () => {
    const diff = parsed();
    expect(diff.hunks[0]?.unifiedLineStart).toBe(H);
    expect(diffRowAt(diff, H - 1)).toBeNull();
    expect(diffRowAt(diff, H)).toEqual({ side: "additions", lineNumber: 10 });
    expect(diffRowAt(diff, H + 1)).toEqual({ side: "deletions", lineNumber: 11 });
    expect(diffRowAt(diff, H + 2)).toEqual({ side: "deletions", lineNumber: 12 });
    expect(diffRowAt(diff, H + 3)).toEqual({ side: "additions", lineNumber: 11 });
    expect(diffRowAt(diff, H + 5)).toEqual({ side: "additions", lineNumber: 13 });
    expect(diffRowAt(diff, H + 6)).toEqual({ side: "additions", lineNumber: 14 });
  });

  it("numbers later hunks from their own header", () => {
    const diff = parsed();
    const second = diff.hunks[1];
    if (!second) throw new Error("expected two hunks");
    const start = second.unifiedLineStart;
    expect(diffRowAt(diff, start)).toEqual({ side: "additions", lineNumber: 41 });
    expect(diffRowAt(diff, start + 1)).toEqual({ side: "deletions", lineNumber: 41 });
    expect(diffRowAt(diff, start + 2)).toEqual({ side: "additions", lineNumber: 42 });
    expect(diffRowAt(diff, start + 3)).toBeNull();
  });
});

describe("diffRowRange", () => {
  it("keeps the range on the last row's side", () => {
    const diff = parsed();
    expect(diffRowRange(diff, H + 4, H + 1)).toEqual({
      side: "additions",
      startLine: 11,
      endLine: 12,
    });
    expect(diffRowRange(diff, H, H + 5)).toEqual({ side: "additions", startLine: 10, endLine: 13 });
    expect(diffRowRange(diff, H + 1, H + 2)).toEqual({
      side: "deletions",
      startLine: 11,
      endLine: 12,
    });
  });

  it("is a single line for a single row", () => {
    expect(diffRowRange(parsed(), H + 3, H + 3)).toEqual({
      side: "additions",
      startLine: 11,
      endLine: 11,
    });
  });
});

describe("row ordinals", () => {
  it("counts every rendered row and skips the collapsed gaps", () => {
    const diff = parsed();
    const second = diff.hunks[1]?.unifiedLineStart;
    expect(diffRowCount(diff)).toBe(10);
    expect(rowIndexAt(diff, 0)).toBe(H);
    expect(rowIndexAt(diff, 6)).toBe(H + 6);
    expect(rowIndexAt(diff, 7)).toBe(second ?? -1);
    expect(rowIndexAt(diff, 10)).toBeNull();
  });
});

describe("rowIndexForNewLine", () => {
  it("lands on the first non-deletion row at or past the line", () => {
    const diff = parsed();
    const second = diff.hunks[1]?.unifiedLineStart ?? -1;
    expect(rowIndexForNewLine(diff, 1)).toBe(H);
    expect(rowIndexForNewLine(diff, 11)).toBe(H + 3);
    expect(rowIndexForNewLine(diff, 42)).toBe(second + 2);
    expect(rowIndexForNewLine(diff, 99)).toBe(second + 2);
  });
});
