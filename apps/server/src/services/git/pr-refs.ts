// Every name Revv gives to a ref or branch in a clone. The clone may be the
// user's own repository, so all of them live in namespaces the user doesn't
// write to, and each has exactly one writer. Folders are named in
// `services/clone/layout.ts`.

/**
 * The PR's agent branch, checked out in its worktree. Its name must stay
 * unambiguous: git resolves `refs/<name>` before `refs/heads/<name>`, so no
 * ref may ever be called `refs/revv/pr-N` (see {@link legacyPrRef}).
 */
export const agentBranch = (prNumber: number) => `revv/pr-${prNumber}`;

/** The PR number of an agent branch (`revv/pr-N` or `refs/heads/revv/pr-N`), else null. */
export function agentBranchPr(ref: string): number | null {
  const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  const match = /^revv\/pr-(\d+)$/.exec(name);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** Where the PR head is fetched, in a namespace that shares no name with a branch. */
export const prFetchRef = (prNumber: number) => `refs/revv-pull/${prNumber}`;

/**
 * Where an older Revv fetched the PR head (legacy-upgrade: prRefNamespace).
 * It made the bare name `revv/pr-N` resolve to the PR head instead of the
 * agent branch, so every reader and writer deletes it on sight.
 */
export const legacyPrRef = (prNumber: number) => `refs/revv/pr-${prNumber}`;

/**
 * A ref one run fetches into and deletes when done. Each feature has its own
 * namespace, so a run never deletes another's refs: the base-conflicts check
 * and the base sync of one PR may overlap.
 */
export const scratchRef = (
  feature: "base-conflicts" | "base-sync" | "stack-rebase" | "chat-push",
  key: number,
  name: string,
) => `refs/revv/${feature}/${key}/${name}`;

/** Every namespace above, for tearing a repository down. */
export const REVV_REF_NAMESPACES = ["refs/revv", "refs/revv-pull"] as const;
