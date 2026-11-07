import { parseDiffFromFile } from "@pierre/diffs";
import type { ToolDiffOutput } from "@revv/shared";

export interface DiffStats {
  readonly additions: number;
  readonly deletions: number;
}

/** Lines an edit added and removed. */
export function diffLineStats(diff: ToolDiffOutput): DiffStats {
  const name = diff.path || "file";
  const meta = parseDiffFromFile(
    { name, contents: diff.oldText },
    { name, contents: diff.newText },
  );
  let additions = 0;
  let deletions = 0;
  for (const hunk of meta.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}
