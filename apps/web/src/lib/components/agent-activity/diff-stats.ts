import { parseDiffFromFile } from "@pierre/diffs";
import type { ToolDiffOutput } from "@revv/shared";

export interface DiffStats {
  readonly additions: number;
  readonly deletions: number;
}

/** Lines an edit added and removed, or null when Pierre can't parse the pair. */
export function diffLineStats(diff: ToolDiffOutput): DiffStats | null {
  const name = diff.path || "file";
  let meta: ReturnType<typeof parseDiffFromFile>;
  try {
    meta = parseDiffFromFile({ name, contents: diff.oldText }, { name, contents: diff.newText });
  } catch {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  for (const hunk of meta.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}
