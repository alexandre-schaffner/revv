import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";
import type { GitStatus } from "@pierre/trees";
import type { ProposedDiffFile } from "./api";

/** A file a proposed commit touched. `diff` is null for a binary file. */
export interface ProposedFile {
  readonly path: string;
  readonly status: GitStatus;
  readonly diff: FileDiffMetadata | null;
}

/** git's name-status letter; a rename carries a similarity score (`R100`). */
function treeStatus(nameStatus: string): GitStatus {
  switch (nameStatus[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * Every file of a proposed commit, in the server's order. Text diffs are
 * built from whole file pairs: a whole-file diff is non-partial, which is
 * what lets Pierre expand the context between hunks (it gates `isExpandable`
 * on `!isPartial`).
 */
export function proposedFiles(sha: string, files: readonly ProposedDiffFile[]): ProposedFile[] {
  return files.map((f, i) => {
    const cacheKey = `chat-diff-${sha}-${i}`;
    return {
      path: f.path,
      status: treeStatus(f.status),
      diff: f.binary
        ? null
        : parseDiffFromFile(
            { name: f.oldPath ?? f.path, contents: f.oldContent ?? "", cacheKey: `${cacheKey}-old` },
            { name: f.path, contents: f.newContent ?? "", cacheKey: `${cacheKey}-new` },
          ),
    };
  });
}
