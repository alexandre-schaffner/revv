// Where Revv keeps what it puts on disk for a repository row: its clone, and
// the worktrees it checks out of that clone. Rows are unique per account, and
// two accounts may track one GitHub repository, so every folder is keyed on
// the row: no two rows ever share a clone or a worktree.
//
//   <base>/<owner>/<name>             a managed clone (the user may pick another base)
//   <base>/<owner>/<name>.<row id>    the same, when another row already holds the first
//   <base>/.worktrees/<row id>/       every worktree Revv checks out of that row's clone
//
// `.worktrees` can't collide with an owner: GitHub logins never start with a dot.

import { join } from "node:path";
import { serverEnv } from "../../config";

/** Revv's own base for managed clones (`REVV_CLONE_DIR`), and where every worktree lives. */
export const CLONE_BASE_DIR = serverEnv.cloneDir;

interface RepoRow {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
}

const HOLDERS_DIR = ".worktrees";

const AGENT_PREFIX = "pr-";
const REVIEW_PREFIX = "review-";

export function cloneLayout(base: string) {
  const holder = (repoId: string) => join(base, HOLDERS_DIR, repoId);
  return {
    base,
    /** Where a new clone of `repo` goes under `root` (Revv's base, or the base the user picked). */
    clonePath: (root: string, repo: RepoRow) => join(root, repo.owner, repo.name),
    /** The same, for a row whose {@link clonePath} another row already holds. */
    distinctClonePath: (root: string, repo: RepoRow) =>
      join(root, repo.owner, `${repo.name}.${repo.id}`),
    holder,
    /** The PR's agent worktree, on its agent branch (see `PrWorkspace`). */
    agentWorktree: (repoId: string, prNumber: number) =>
      join(holder(repoId), `${AGENT_PREFIX}${prNumber}`),
    /** Detached worktrees, one per run, cleared by the next run of the same key. */
    scratch: {
      baseSync: (repoId: string, prNumber: number) =>
        join(holder(repoId), `base-sync-pr-${prNumber}`),
      stackRebase: (repoId: string, stackNumber: number) =>
        join(holder(repoId), `stack-${stackNumber}-rebase`),
      review: (repoId: string, walkthroughId: string) =>
        join(holder(repoId), `${REVIEW_PREFIX}${walkthroughId}`),
    },
    /**
     * Where an older Revv kept a row's worktrees: shared by every row of one
     * `owner/name` (legacy-upgrade: rowKeyedFolders).
     */
    legacyHolder: (repo: { readonly owner: string; readonly name: string }) =>
      join(base, repo.owner, repo.name, "worktrees"),
  };
}

export type CloneLayout = ReturnType<typeof cloneLayout>;

/** The PR number of an agent worktree's directory name, or null for any other worktree. */
export function agentWorktreePr(dirName: string): number | null {
  const match = /^pr-(\d+)$/.exec(dirName);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** The walkthrough a review worktree's directory name belongs to, or null for any other worktree. */
export function reviewWorktreeId(dirName: string): string | null {
  return dirName.startsWith(REVIEW_PREFIX) ? dirName.slice(REVIEW_PREFIX.length) : null;
}
