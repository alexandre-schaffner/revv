import { describe, expect, it } from "bun:test";
import type { HunkScanRow } from "@revv/shared";
import { rowsInPrompt } from "./walkthrough-leads";

const row = (filePath: string, newStart: number, newLines: number): HunkScanRow => ({
  filePath,
  hunkIndex: 0,
  oldStart: newStart,
  oldLines: newLines,
  newStart,
  newLines,
  skipReason: null,
  signals: null,
  scannedAt: null,
});

const file = (filename: string, patch: string | null) => ({
  filename,
  previousFilename: null,
  status: "modified",
  additions: 0,
  deletions: 0,
  patch,
});

describe("rowsInPrompt", () => {
  const rows = [row("a.ts", 10, 5), row("a.ts", 100, 5), row("b.ts", 1, 3)];

  it("keeps every row of a prompted file on a full-PR prompt", () => {
    const shown = rowsInPrompt(rows, { files: [file("a.ts", null)], diffSource: "full_pr" });
    expect(shown.map((r) => r.newStart)).toEqual([10, 100]);
  });

  it("keeps only rows overlapping the incremental range's hunks", () => {
    const patch = "@@ -98,3 +102,2 @@\n ctx\n+added\n";
    const shown = rowsInPrompt(rows, {
      files: [file("a.ts", patch), file("b.ts", null)],
      diffSource: "incremental_range",
    });
    expect(shown.map((r) => `${r.filePath}:${r.newStart}`)).toEqual(["a.ts:100"]);
  });
});
