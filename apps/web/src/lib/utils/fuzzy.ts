/**
 * Lightweight fuzzy scorer shared by the command palette (Cmd+P) and the
 * sidebar PR search. Higher score = better match; -1 means "no match".
 *
 * The algorithm is intentionally tiny:
 *   - Empty query scores 0 (caller decides "no filter" semantics).
 *   - Exact substring → score 100, plus a 50-point boost when the match starts
 *     at index 0. This keeps prefix matches above mid-string substring matches.
 *   - Otherwise, sequential character match: each matched query char awards
 *     5 points, with a +10 bonus when the match falls on a word boundary
 *     (start of string, or after whitespace / `-` / `_` / `/`). All query
 *     chars must match in order, otherwise the score is -1.
 *
 * Both `query` and `text` are compared case-insensitively. The function does
 * no allocation other than the two `toLowerCase()` calls, so it's safe to call
 * inside reactive `$derived.by` blocks across hundreds of rows.
 */
export function fuzzyScore(query: string, text: string): number {
	if (query.length === 0) return 0;

	const lq = query.toLowerCase();
	const lt = text.toLowerCase();

	// Exact substring match — best score. Boost prefix matches over mid-string.
	const idx = lt.indexOf(lq);
	if (idx !== -1) {
		return 100 + (idx === 0 ? 50 : 0);
	}

	// Sequential character match (fuzzy). All query chars must match, in order.
	let qi = 0;
	let score = 0;
	for (let ti = 0; ti < lt.length && qi < lq.length; ti++) {
		if (lt[ti] === lq[qi]) {
			// Word-boundary bonus: start of string, or right after a separator.
			if (ti === 0 || /[\s\-_/]/.test(lt[ti - 1]!)) score += 10;
			score += 5;
			qi++;
		}
	}

	return qi === lq.length ? score : -1;
}
