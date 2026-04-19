import type { CommentThread } from '@revv/shared';

export interface ThreadFileGroup {
	filePath: string;
	threads: CommentThread[];
}

/**
 * Bucket threads by filePath. Groups are ordered alphabetically by filePath
 * (locale-aware). Within each group, threads are ordered by startLine
 * ascending so the visual order matches the on-file reading order. Empty
 * inputs return an empty array.
 *
 * Mirrors the bucket-then-iterate precedent in `walkthrough-issues.ts`
 * (`groupIssuesBySeverity`). Pure function — no store reads, no side effects.
 */
export function groupThreadsByFile(
	threads: readonly CommentThread[],
): ThreadFileGroup[] {
	const buckets = new Map<string, CommentThread[]>();
	for (const t of threads) {
		const bucket = buckets.get(t.filePath);
		if (bucket) bucket.push(t);
		else buckets.set(t.filePath, [t]);
	}
	const sortedPaths = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
	return sortedPaths.map((filePath) => ({
		filePath,
		threads: (buckets.get(filePath) ?? [])
			.slice()
			.sort((a, b) => a.startLine - b.startLine),
	}));
}
