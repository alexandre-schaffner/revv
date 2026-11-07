import type { CommentThread } from "@revv/shared";
import type { CachedDiffFile } from "./DiffCache";
import { fitAnchorToPatch } from "./diff-anchors";
import type { GhCommentAnchor } from "./github/reviews";

export type GitHubCommentFit =
  | { readonly ok: true; readonly comment: GhCommentAnchor }
  | { readonly ok: false; readonly reason: string };

/** The cached diff's entry for `path`, a rename's old path included. */
export function diffFileFor(
  files: readonly CachedDiffFile[] | null,
  path: string,
): CachedDiffFile | undefined {
  return files?.find((f) => f.path === path || f.oldPath === path);
}

/**
 * A thread as a GitHub review comment, its anchor fitted onto `patch`.
 * GitHub answers a comment on a line outside the diff, or spanning two hunks,
 * with an opaque 422 (for a review, it rejects the whole review), and threads
 * can point there: the walkthrough agent flags ranges it read in the full
 * file, and a reviewer can comment on any line. A null `patch` is sent as is.
 */
export function toGitHubComment(
  thread: Pick<CommentThread, "filePath" | "startLine" | "endLine" | "diffSide">,
  body: string,
  patch: string | null,
): GitHubCommentFit {
  const side = thread.diffSide === "old" ? "LEFT" : "RIGHT";
  const fit = fitAnchorToPatch(patch, {
    startLine: thread.startLine,
    endLine: thread.endLine,
    side,
  });
  if (!fit.ok) return fit;
  const comment = { path: thread.filePath, body, line: fit.endLine, side } as const;
  return {
    ok: true,
    comment: fit.startLine === fit.endLine ? comment : { ...comment, startLine: fit.startLine },
  };
}
