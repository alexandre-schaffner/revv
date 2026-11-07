import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";
import type { ProposedDiffFile } from "./api";

/**
 * The diffs of a proposed commit, built from whole file pairs. A whole-file
 * diff is non-partial, which is what lets Pierre expand the context between
 * hunks (it gates `isExpandable` on `!isPartial`). Binary files (both
 * contents null) are left out; a rename with no content change is listed as
 * `rename-pure`, with no hunks.
 */
export function proposedFileDiffs(
  sha: string,
  files: readonly ProposedDiffFile[],
): FileDiffMetadata[] {
  return files.flatMap((f, i) => {
    if (f.binary) return [];
    const cacheKey = `chat-diff-${sha}-${i}`;
    return [
      parseDiffFromFile(
        { name: f.oldPath ?? f.path, contents: f.oldContent ?? "", cacheKey: `${cacheKey}-old` },
        { name: f.path, contents: f.newContent ?? "", cacheKey: `${cacheKey}-new` },
      ),
    ];
  });
}
