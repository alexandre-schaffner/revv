/**
 * Count the total number of rendered lines in a patch string.
 * Counts all +, -, and context (space-prefixed) lines from hunks.
 */
export function countPatchLines(patch: string): number {
	const lines = patch.split('\n');
	let count = 0;
	for (const line of lines) {
		const ch = line[0];
		// + (addition), - (deletion), or space (context) — all are rendered rows
		if (ch === '+' || ch === '-' || ch === ' ') {
			count++;
		}
	}
	return count;
}
