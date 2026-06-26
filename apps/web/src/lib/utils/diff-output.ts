// ── Structured diff output (file edits) ──────────────────────────────────────
//
// File-edit tool calls carry a sentinel-tagged JSON old/new pair in their
// activity `output` (produced by the ACP decoder's `extractToolOutput`). The
// wire shape + encode/decode live in `@revv/shared` (`decodeToolDiffOutput`)
// so server and web can never drift; this module only adds the web-side LOC
// counting via Pierre's diff parser.

import { parseDiffFromFile } from "@pierre/diffs";
import { decodeToolDiffOutput, type ToolDiffOutput } from "@revv/shared";

export type DiffOutput = ToolDiffOutput;

/** Parse an activity `output` as a structured edit diff, or null if it isn't one. */
export function parseDiffOutput(output: string | undefined): DiffOutput | null {
  return decodeToolDiffOutput(output);
}

export interface DiffStats {
  readonly additions: number;
  readonly deletions: number;
}

/** Count added/removed lines for an edit, via Pierre's diff parser. */
export function diffLineStats(diff: DiffOutput): DiffStats {
  try {
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
  } catch {
    return { additions: 0, deletions: 0 };
  }
}
