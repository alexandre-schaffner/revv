// ── Unified-diff hunks ──────────────────────────────────────────────────────
//
// A hunk's position among its patch's hunks is its `hunkIndex`: the server's
// first-pass rows, the web's scan ribbon and `@pierre/diffs` all address hunks
// by it, so every side splits patches here.

/** The ranges a hunk header declares: `@@ -a[,b] +c[,d] @@`. An omitted count means 1. */
export interface HunkHeader {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The ranges of a hunk header, or null when the line isn't one. A bare `@@`
 * or a `@@ section label @@` without ranges is not a header: Pierre's parser
 * yields no hunk for it.
 */
export function parseHunkHeader(line: string): HunkHeader | null {
  const m = HUNK_HEADER.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/** One `@@` hunk of a patch. */
export interface PatchHunk extends HunkHeader {
  /** Position among the patch's hunks — the same `hunkIndex` `@pierre/diffs` assigns. */
  readonly index: number;
  readonly header: string;
  /** The header line and every line under it, joined with `\n`. */
  readonly body: string;
  /** Added lines, `+` stripped. */
  readonly addedLines: readonly string[];
}

/** Split a unified patch into its hunks. Preamble before the first header is dropped. */
export function splitHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: { header: string; ranges: HunkHeader; lines: string[]; added: string[] } | null =
    null;

  const flush = () => {
    if (!current) return;
    hunks.push({
      index: hunks.length,
      header: current.header,
      ...current.ranges,
      body: current.lines.join("\n"),
      addedLines: current.added,
    });
  };

  const lines = patch.split("\n");
  // A patch ending in a newline would otherwise leave an empty context line on its last hunk.
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    const ranges = parseHunkHeader(line);
    if (ranges) {
      flush();
      current = { header: line, ranges, lines: [line], added: [] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith("+")) current.added.push(line.slice(1));
  }
  flush();
  return hunks;
}
