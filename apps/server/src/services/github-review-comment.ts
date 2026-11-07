import {
  type CommentThread,
  draftCommentBody,
  isPublishableDraftComment,
  type ThreadMessage,
} from "@revv/shared";
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

export type ThreadCommentPlan =
  | {
      readonly kind: "post";
      readonly comment: GhCommentAnchor;
      /** The drafts the comment carries; they become it once posted. */
      readonly draftIds: readonly string[];
    }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * What a thread not yet on GitHub posts: its publishable drafts as one review
 * comment, or why it can't go up. Null when it has nothing to post. The cached
 * diff is the PR head's, so a file it doesn't hold left the diff, and GitHub
 * would reject the comment; with no cached diff nothing is known to be stale.
 */
export function planThreadComment(
  thread: CommentThread,
  messages: readonly ThreadMessage[],
  viewerLogin: string | null,
  cachedFiles: readonly CachedDiffFile[] | null,
): ThreadCommentPlan | null {
  const text = draftCommentBody(thread, messages, viewerLogin);
  if (text === null) return null;
  const file = diffFileFor(cachedFiles, thread.filePath);
  if (cachedFiles !== null && cachedFiles.length > 0 && !file) {
    return { kind: "skip", reason: "the file is no longer part of the diff" };
  }
  const fit = toGitHubComment(thread, text, file?.patch ?? null);
  if (!fit.ok) return { kind: "skip", reason: fit.reason };
  return {
    kind: "post",
    comment: fit.comment,
    draftIds: messages.filter((m) => isPublishableDraftComment(m, viewerLogin)).map((m) => m.id),
  };
}
