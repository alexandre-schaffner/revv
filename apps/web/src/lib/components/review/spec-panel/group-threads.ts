import type { CommentThread } from "@revv/shared";

export interface ThreadFileGroup {
  filePath: string;
  threads: CommentThread[];
}

/**
 * Groups ordered by filePath (locale-aware), threads within one by startLine,
 * so the order matches the file's reading order.
 */
export function groupThreadsByFile(threads: readonly CommentThread[]): ThreadFileGroup[] {
  const buckets = new Map<string, CommentThread[]>();
  for (const t of threads) {
    const bucket = buckets.get(t.filePath);
    if (bucket) bucket.push(t);
    else buckets.set(t.filePath, [t]);
  }
  const sortedPaths = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  return sortedPaths.map((filePath) => ({
    filePath,
    threads: (buckets.get(filePath) ?? []).slice().sort((a, b) => a.startLine - b.startLine),
  }));
}
