// ── Review file type (for @pierre/diffs integration) ────────────────────────

/** A file in the review, with the git patch for @pierre/diffs to render. */
export interface ReviewFile {
  path: string;
  oldPath?: string;
  /** Unified diff (patch) string from the GitHub API, or null for binary files. */
  patch: string | null;
  additions: number;
  deletions: number;
  isNew?: boolean;
  isDeleted?: boolean;
  isBinary?: boolean;
}

// ── Comment / Thread types (re-exported from @revv/shared) ────────────────────

export type {
  CommentThread,
  ThreadMessage,
} from "@revv/shared";
