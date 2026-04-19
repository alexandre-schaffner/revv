import type { WalkthroughRating } from '@revv/shared';

/**
 * Smart-synthesis helper for the grid-view rating cells. Produces a single
 * short one-line detail string that gives the reviewer just enough signal to
 * decide whether to open the full popover.
 *
 * Strategy:
 *   pass                 → first sentence of the rationale, lightly truncated.
 *   concern / blocker    → "N issues in {basename}" when all citations hit one
 *                          file, "N issues across K files" when spread, or a
 *                          truncated rationale if no citations are present.
 *
 * The helper is deliberately pure (no Svelte, no DOM) so it's trivial to
 * unit-test and reason about in isolation.
 */

/** Max character count for truncated rationale text. Chosen empirically: at
 *  the grid cell's ~220px inner width the monospace synthesis line fits ~60
 *  chars before it starts clipping, and that length is typically enough to
 *  give a useful first-sentence preview. */
const RATIONALE_MAX_CHARS = 60;

/** Ellipsis character appended when a rationale overflows RATIONALE_MAX_CHARS.
 *  We use the single-codepoint "…" rather than "..." so the length budget
 *  stays tight. */
const ELLIPSIS = '…';

/** Extract the last `/`-separated segment of a path. Returns the input
 *  unchanged if it contains no `/` (so "foo.ts" stays "foo.ts"). Returns an
 *  empty string for an empty/undefined input — callers decide whether to fall
 *  back. */
function basename(filePath: string): string {
	if (!filePath) return '';
	const idx = filePath.lastIndexOf('/');
	return idx === -1 ? filePath : filePath.slice(idx + 1);
}

/** Trim and single-line a rationale, then cap it at RATIONALE_MAX_CHARS with
 *  an ellipsis. Character-based (not word-boundary) — documented trade-off in
 *  the plan. Returns `null` for empty/whitespace-only input so the caller can
 *  choose to render nothing rather than an empty detail line. */
function truncateRationale(rationale: string): string | null {
	const trimmed = rationale.trim();
	if (trimmed.length === 0) return null;
	// Collapse embedded newlines — the grid cell renders on one line and we
	// don't want a leading whitespace artefact.
	const oneLine = trimmed.replace(/\s+/g, ' ');
	// First-sentence split. `". "` is conservative: it avoids splitting on
	// "e.g." or "i.e." which don't have a trailing space after the period.
	const firstSentence = oneLine.split('. ')[0] ?? oneLine;
	if (firstSentence.length <= RATIONALE_MAX_CHARS) return firstSentence;
	return firstSentence.slice(0, RATIONALE_MAX_CHARS - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Produce a one-line synthesis string for a resolved rating.
 *
 * Returns an empty string for passes with no rationale — the caller (the grid
 * cell) should check for empty and skip rendering the detail line in that
 * case rather than emit an empty element.
 */
export function synthesize(rating: WalkthroughRating): string {
	if (rating.verdict === 'pass') {
		return truncateRationale(rating.rationale) ?? '';
	}

	// concern / blocker: prefer structured citation summary.
	const citations = rating.citations;
	if (citations.length === 0) {
		return truncateRationale(rating.rationale) ?? '';
	}

	// Group citations by file. Defensive fallback for citations that somehow
	// have a missing or empty filePath — in that case we treat the rationale
	// as the source of truth so the user gets something meaningful.
	const fileSet = new Set<string>();
	for (const c of citations) {
		if (c.filePath) fileSet.add(c.filePath);
	}

	if (fileSet.size === 0) {
		// Shouldn't happen in practice — citations always carry a path — but
		// defensively fall back rather than producing "2 issues in ".
		return truncateRationale(rating.rationale) ?? '';
	}

	const issueCount = citations.length;
	const issueWord = issueCount === 1 ? 'issue' : 'issues';

	if (fileSet.size === 1) {
		const filePath = fileSet.values().next().value as string;
		const file = basename(filePath);
		if (!file) return truncateRationale(rating.rationale) ?? '';
		return `${issueCount} ${issueWord} in ${file}`;
	}

	return `${issueCount} ${issueWord} across ${fileSet.size} files`;
}
