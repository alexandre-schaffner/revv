// Every name Revv gives to a ref, branch or worktree in a clone. The clone may
// be the user's own repository, so all of them live in namespaces the user
// doesn't write to, and each has exactly one writer.

/**
 * The PR's agent branch, checked out in its worktree. Its name must stay
 * unambiguous: git resolves `refs/<name>` before `refs/heads/<name>`, so no
 * ref may ever be called `refs/revv/pr-N` (see {@link legacyPrRef}).
 */
export const agentBranch = (prNumber: number) => `revv/pr-${prNumber}`;

export const agentWorktreeDir = (prNumber: number) => `pr-${prNumber}`;

/** Where the PR head is fetched, in a namespace that shares no name with a branch. */
export const prFetchRef = (prNumber: number) => `refs/revv-pull/${prNumber}`;

/**
 * Where an older Revv fetched the PR head. It made the bare name `revv/pr-N`
 * resolve to the PR head instead of the agent branch, so every reader and
 * writer deletes it on sight.
 */
export const legacyPrRef = (prNumber: number) => `refs/revv/pr-${prNumber}`;

export const scratchRef = (feature: "base-conflicts" | "stack-rebase", key: number, name: string) =>
  `refs/revv/${feature}/${key}/${name}`;

/** Every namespace above, for tearing a repository down. */
export const REVV_REF_NAMESPACES = ["refs/revv", "refs/revv-pull"] as const;

/** Scratch worktrees: detached, one per run, cleared by the next run of the same key. */
export const scratchWorktreeDir = {
  baseSync: (prNumber: number) => `base-sync-pr-${prNumber}`,
  stackRebase: (stackNumber: number) => `stack-${stackNumber}-rebase`,
  review: (walkthroughId: string) => `review-${walkthroughId}`,
} as const;

export function reviewWorktreeId(dir: string): string | null {
  return dir.startsWith("review-") ? dir.slice("review-".length) : null;
}
