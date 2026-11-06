import type { WalkthroughRating } from "@revv/shared";

/**
 * One-line detail for a grid rating cell: just enough signal for the reviewer
 * to decide whether to open the full popover.
 */

/** At the grid cell's ~220px inner width the mono line fits ~60 chars. */
const RATIONALE_MAX_CHARS = 60;

const ELLIPSIS = "…";

function basename(filePath: string): string {
  if (!filePath) return "";
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

function truncateRationale(rationale: string): string | null {
  const trimmed = rationale.trim();
  if (trimmed.length === 0) return null;
  const oneLine = trimmed.replace(/\s+/g, " ");
  // First-sentence split. `". "` is conservative: it avoids splitting on
  // "e.g." or "i.e." which don't have a trailing space after the period.
  const firstSentence = oneLine.split(". ")[0] ?? oneLine;
  if (firstSentence.length <= RATIONALE_MAX_CHARS) return firstSentence;
  return firstSentence.slice(0, RATIONALE_MAX_CHARS - ELLIPSIS.length) + ELLIPSIS;
}

/** Empty for a pass with no rationale; the cell then skips its detail line. */
export function synthesize(rating: WalkthroughRating): string {
  if (rating.verdict === "pass") {
    return truncateRationale(rating.rationale) ?? "";
  }

  const citations = rating.citations;
  if (citations.length === 0) {
    return truncateRationale(rating.rationale) ?? "";
  }

  const fileSet = new Set<string>();
  for (const c of citations) {
    if (c.filePath) fileSet.add(c.filePath);
  }

  if (fileSet.size === 0) {
    return truncateRationale(rating.rationale) ?? "";
  }

  const issueCount = citations.length;
  const issueWord = issueCount === 1 ? "issue" : "issues";

  if (fileSet.size === 1) {
    const filePath = fileSet.values().next().value as string;
    const file = basename(filePath);
    if (!file) return truncateRationale(rating.rationale) ?? "";
    return `${issueCount} ${issueWord} in ${file}`;
  }

  return `${issueCount} ${issueWord} across ${fileSet.size} files`;
}
