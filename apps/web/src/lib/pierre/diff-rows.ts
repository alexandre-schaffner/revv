// The rows of a patch-only diff as Pierre renders them. Pierre stamps each
// row with a unified index (`data-line-index="<unified>,<split>"`) that also
// counts the collapsed lines between hunks, so the first row of a hunk at
// line 40 is index 39, not 0. Within a hunk a context block is one row per
// line, and a change block lists its deletions before its additions.

import type { FileDiffMetadata } from "@pierre/diffs";

export type DiffSide = "deletions" | "additions";

export interface DiffRow {
  side: DiffSide;
  lineNumber: number;
}

export interface DiffLineRange {
  side: DiffSide;
  startLine: number;
  endLine: number;
}

/** The file line under unified row `index`, or null between hunks or past the end. */
export function diffRowAt(diff: FileDiffMetadata, index: number): DiffRow | null {
  const hunk = diff.hunks.find(
    (h) => index >= h.unifiedLineStart && index < h.unifiedLineStart + h.unifiedLineCount,
  );
  if (!hunk) return null;
  let row = hunk.unifiedLineStart;
  let oldLine = hunk.deletionStart;
  let newLine = hunk.additionStart;
  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      if (index < row + content.lines)
        return { side: "additions", lineNumber: newLine + index - row };
      row += content.lines;
      oldLine += content.lines;
      newLine += content.lines;
      continue;
    }
    if (index < row + content.deletions) {
      return { side: "deletions", lineNumber: oldLine + index - row };
    }
    row += content.deletions;
    oldLine += content.deletions;
    if (index < row + content.additions) {
      return { side: "additions", lineNumber: newLine + index - row };
    }
    row += content.additions;
    newLine += content.additions;
  }
  return null;
}

/**
 * Rows `from..to` (either order) as one side's line range — the side of the
 * last row, since a comment sits on one side of the diff.
 */
export function diffRowRange(
  diff: FileDiffMetadata,
  from: number,
  to: number,
): DiffLineRange | null {
  const first = Math.min(from, to);
  const last = Math.max(from, to);
  const end = diffRowAt(diff, last);
  if (!end) return null;
  let startLine = end.lineNumber;
  for (let index = first; index < last; index++) {
    const row = diffRowAt(diff, index);
    if (row?.side === end.side) {
      startLine = Math.min(startLine, row.lineNumber);
    }
  }
  return { side: end.side, startLine, endLine: end.lineNumber };
}

export function diffRowCount(diff: FileDiffMetadata): number {
  return diff.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0);
}

/** The unified index of the `ordinal`-th rendered row (0-based, in display order). */
export function rowIndexAt(diff: FileDiffMetadata, ordinal: number): number | null {
  let remaining = ordinal;
  for (const hunk of diff.hunks) {
    if (remaining < hunk.unifiedLineCount) return hunk.unifiedLineStart + remaining;
    remaining -= hunk.unifiedLineCount;
  }
  return null;
}

/**
 * The row showing new-file line `line`: the first context or added row at or
 * past it, else the diff's last such row.
 */
export function rowIndexForNewLine(diff: FileDiffMetadata, line: number): number | null {
  let best: number | null = null;
  for (const hunk of diff.hunks) {
    for (
      let index = hunk.unifiedLineStart;
      index < hunk.unifiedLineStart + hunk.unifiedLineCount;
      index++
    ) {
      const row = diffRowAt(diff, index);
      if (row?.side !== "additions") continue;
      if (row.lineNumber >= line) return index;
      best = index;
    }
  }
  return best;
}
