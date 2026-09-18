/**
 * Fitting comment anchors onto a unified diff.
 *
 * GitHub only accepts a review comment whose `line` (and `start_line`, for a
 * multi-line comment) is a line the PR's diff actually contains, with both
 * ends inside the *same* hunk. Anchors that miss produce a 422 that rejects
 * the **entire** review — one stale comment blocks an approve.
 *
 * Revv produces anchors from two sources that can both fall outside the diff:
 * the walkthrough agent, which reads whole files in a worktree and flags a
 * range it read there, and the file viewer, where a reviewer can comment on
 * any line of a file regardless of the diff. So every anchor is fitted to the
 * diff before it is sent.
 */

/** A hunk header carrying explicit ranges: `@@ -a[,b] +c[,d] @@`. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The line numbers one hunk exposes on each side of the diff. */
interface HunkLines {
  readonly left: readonly number[];
  readonly right: readonly number[];
}

/**
 * The line numbers a patch makes commentable, grouped by hunk.
 *
 * A context line is commentable on both sides, an addition only on the right,
 * a deletion only on the left — matching what GitHub will accept for a
 * `side: LEFT | RIGHT` comment.
 */
export function commentableLines(patch: string): HunkLines[] {
  const hunks: HunkLines[] = [];
  let current: { left: number[]; right: number[] } | null = null;
  let leftLine = 0;
  let rightLine = 0;

  const lines = patch.split("\n");
  // `split` leaves a trailing empty element for a patch ending in a newline.
  // Counting it as a context line would make one extra line look commentable.
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      if (current) hunks.push(current);
      leftLine = Number(header[1]);
      rightLine = Number(header[2]);
      current = { left: [], right: [] };
      continue;
    }
    if (!current) continue; // preamble before the first hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("+")) current.right.push(rightLine++);
    else if (line.startsWith("-")) current.left.push(leftLine++);
    else {
      // Context line. A blank one arrives as " " from git, but some producers
      // strip the trailing space — an empty string here is still context.
      current.left.push(leftLine++);
      current.right.push(rightLine++);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

export interface CommentAnchor {
  readonly startLine: number;
  readonly endLine: number;
  readonly side: "LEFT" | "RIGHT";
}

export type AnchorFit =
  | { readonly ok: true; readonly startLine: number; readonly endLine: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Narrow `anchor` to the lines its diff actually contains.
 *
 * The fitted range is the anchor intersected with one hunk — GitHub's other
 * hard requirement is that both ends live in the same one. The hunk holding
 * `endLine` wins, because that is the line GitHub hangs the comment off; the
 * one holding `startLine` is the fallback, and failing both, the hunk the
 * anchor overlaps most. An anchor that overlaps no hunk on its side cannot be
 * posted at all and comes back `ok: false`.
 *
 * A null or empty patch (binary file, or a diff GitHub truncated) is
 * unverifiable, so the anchor passes through untouched rather than being
 * dropped on a guess.
 */
export function fitAnchorToPatch(patch: string | null, anchor: CommentAnchor): AnchorFit {
  const unchanged = { ok: true, startLine: anchor.startLine, endLine: anchor.endLine } as const;
  if (patch === null || patch.trim() === "") return unchanged;

  const hunks = commentableLines(patch);
  if (hunks.length === 0) return unchanged;

  const low = Math.min(anchor.startLine, anchor.endLine);
  const high = Math.max(anchor.startLine, anchor.endLine);

  const candidates = hunks.flatMap((hunk) => {
    const lines = anchor.side === "LEFT" ? hunk.left : hunk.right;
    const within = lines.filter((n) => n >= low && n <= high);
    const start = within[0];
    const end = within.at(-1);
    if (start === undefined || end === undefined) return [];
    return [
      { start, end, count: within.length, holdsEnd: end === high, holdsStart: start === low },
    ];
  });

  const best =
    candidates.find((c) => c.holdsEnd) ??
    candidates.find((c) => c.holdsStart) ??
    candidates.reduce<(typeof candidates)[number] | null>(
      (winner, c) => (winner === null || c.count > winner.count ? c : winner),
      null,
    );

  if (!best) {
    const range = low === high ? `line ${low}` : `lines ${low}-${high}`;
    return {
      ok: false,
      reason: `${range} is not part of the diff on the ${anchor.side === "LEFT" ? "old" : "new"} side`,
    };
  }

  return { ok: true, startLine: best.start, endLine: best.end };
}
