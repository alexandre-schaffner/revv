// Git work on a PR's agent branch: the worktree the chat agent commits in, and
// the commits it proposes on top of the PR head. Every address is the branch
// name, never `HEAD`: a push detaches HEAD onto the PR's source branch, and a
// run killed mid-push leaves HEAD and the branch on different commits.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProposedCommit } from "@revv/shared";
import { logError } from "../../logger";
import {
  abortCherryPick,
  abortMerge,
  abortRebase,
  attachedBranch,
  attachHead,
  checkout,
  checkoutDetached,
  cherryPick,
  cleanUntracked,
  commitChanges,
  commitExists,
  forceBranch,
  gitDirs,
  isAncestor,
  isMergeInProgress,
  isValidSha,
  proposedCommitCount,
  proposedCommitLog,
  proposedCommitShas,
  rebaseOnto,
  resetHard,
  resolveRef,
  showFile,
  unmergedPaths,
  unstagedOutsideMerge,
} from "../git/ops";

export interface AgentBranch {
  readonly worktreePath: string;
  readonly branchName: string;
}

const range = (branch: AgentBranch, baseSha: string) => `${baseSha}..${branch.branchName}`;

/**
 * The PR head the agent branch is built on: of the PR heads Revv has seen
 * (each chat session's baseline, the PR's current head), the one that
 * attributes the fewest commits to the agent.
 *
 * Every candidate is a real PR head, so any commit a candidate excludes is the
 * PR's, not the agent's: the tightest is safe whichever way the PR moved. A
 * single frozen baseline is not: after a force-push it reports the PR's whole
 * rewritten history as proposed commits. Ties keep the earlier candidate;
 * callers list the most recently used baseline first. Null when no candidate
 * exists in the worktree.
 */
export async function resolveBaseSha(
  branch: AgentBranch,
  candidates: readonly string[],
): Promise<string | null> {
  let best: { sha: string; count: number } | null = null;
  let fallback: string | null = null;
  for (const sha of new Set(candidates)) {
    if (!isValidSha(sha) || !(await commitExists(branch.worktreePath, sha))) continue;
    fallback ??= sha;
    const count = await proposedCommitCount(branch.worktreePath, range(branch, sha));
    if (count !== null && (best === null || count < best.count)) best = { sha, count };
  }
  return best?.sha ?? fallback;
}

export async function countProposed(branch: AgentBranch, baseSha: string): Promise<number> {
  return (await proposedCommitCount(branch.worktreePath, range(branch, baseSha))) ?? 0;
}

export async function listProposedCommits(
  branch: AgentBranch,
  baseSha: string,
): Promise<ProposedCommit[]> {
  const log = await proposedCommitLog(branch.worktreePath, range(branch, baseSha));
  return log.map((commit) => ({ ...commit, shortSha: commit.sha.slice(0, 7) }));
}

/**
 * The agent's commits that moving the worktree to `headSha` would throw away:
 * the branch isn't built on `headSha` (the PR moved underneath it) and carries
 * proposed commits on the head it is built on. `pinned` are the PR heads the
 * chat sessions were pinned to. Null when the move loses nothing.
 */
export async function commitsStrandedBy(
  branch: AgentBranch,
  headSha: string,
  pinned: readonly string[],
): Promise<{ readonly oldHeadSha: string; readonly commits: ProposedCommit[] } | null> {
  const tip = await resolveRef(branch.worktreePath, branch.branchName);
  if (tip === null || tip === headSha || (await isAncestor(branch.worktreePath, headSha, tip))) {
    return null;
  }
  const oldHeadSha = await resolveBaseSha(branch, [...pinned, headSha]);
  if (oldHeadSha === null) return null;
  const commits = await listProposedCommits(branch, oldHeadSha);
  return commits.length > 0 ? { oldHeadSha, commits } : null;
}

/** The proposed commits in `range`, oldest first. */
export function proposedShas(branch: AgentBranch, baseSha: string): Promise<string[]> {
  return proposedCommitShas(branch.worktreePath, range(branch, baseSha));
}

export interface CommitFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly oldContent: string | null;
  readonly newContent: string | null;
  readonly status: string;
  readonly binary: boolean;
}

/** Each file a commit changed, with both versions, for the diff viewer. */
export async function commitFiles(worktreePath: string, sha: string): Promise<CommitFile[]> {
  const changes = await commitChanges(worktreePath, sha);
  return Promise.all(
    changes.map(async ({ status, filename, previousFilename }) => {
      const oldRef = status === "A" ? null : (previousFilename ?? filename);
      const newRef = status === "D" ? null : filename;
      const [oldRaw, newRaw] = await Promise.all([
        oldRef ? showFile(worktreePath, `${sha}^`, oldRef) : null,
        newRef ? showFile(worktreePath, sha, newRef) : null,
      ]);
      // A NUL anywhere marks it binary; the viewer shows a placeholder.
      const binary = !!(oldRaw?.includes("\0") || newRaw?.includes("\0"));
      return {
        path: filename,
        oldPath: previousFilename,
        status,
        oldContent: binary ? null : oldRaw,
        newContent: binary ? null : newRaw,
        binary,
      };
    }),
  );
}

/** Put the worktree back on the agent branch, best-effort. */
export async function restoreAgentBranch(branch: AgentBranch): Promise<void> {
  if (!(await checkout(branch.worktreePath, branch.branchName)).ok) {
    logError("pr-workspace", `failed to restore the worktree to ${branch.branchName}`);
  }
}

/**
 * Abort a merge a killed push left in the worktree. Returns whether it did.
 *
 * A merge in progress while nobody holds the workspace is Revv's own leftover:
 * the push merges the agent branch into a detached source-branch tip. But
 * `merge --abort` hard-resets the working tree, which the agent also edits, so
 * it only runs when the merge has real conflicts and nothing else is dirty. A
 * blocked push is recoverable; a destroyed uncommitted edit is not.
 */
export async function healAbandonedMerge(branch: AgentBranch): Promise<boolean> {
  const { worktreePath } = branch;
  if (!(await isMergeInProgress(worktreePath))) return false;
  if ((await unmergedPaths(worktreePath)).length === 0) return false;
  const risky = await unstagedOutsideMerge(worktreePath);
  if (risky.length > 0) {
    logError(
      "pr-workspace",
      `refusing to abort the merge in ${worktreePath}: uncommitted changes outside the ` +
        `conflict would be lost — ${risky.join(", ")}`,
    );
    return false;
  }
  logError("pr-workspace", `aborting an abandoned merge in ${worktreePath}`);
  await abortMerge(worktreePath);
  await restoreAgentBranch(branch);
  return true;
}

/** Move the agent branch to `sha` and check it out. */
export async function moveAgentBranch(branch: AgentBranch, sha: string): Promise<boolean> {
  const moved = await forceBranch(branch.worktreePath, branch.branchName, sha);
  return moved.ok && (await checkout(branch.worktreePath, branch.branchName)).ok;
}

/**
 * Replay the agent's commits in `upstream..oldTip` onto `onto` and move the
 * branch there. Commits already in `onto` (a cherry-pick just pushed) are
 * skipped by git's patch-id check. On failure the branch stays at `oldTip`.
 */
export async function replayAgentCommits(
  branch: AgentBranch,
  params: { readonly onto: string; readonly upstream: string; readonly oldTip: string },
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "conflict" | "failed"; readonly message: string }
> {
  const { worktreePath, branchName } = branch;
  const rebased = await rebaseOnto(worktreePath, params.onto, params.upstream, params.oldTip);
  const newTip = rebased.ok ? await resolveRef(worktreePath, "HEAD") : null;
  if (newTip === null) {
    const kind = await failureKind(worktreePath);
    await abortRebase(worktreePath);
    await forceBranch(worktreePath, branchName, params.oldTip);
    await restoreAgentBranch(branch);
    return { ok: false, kind, message: rebased.stderr || "Couldn't read the rebased tip" };
  }
  if (!(await moveAgentBranch(branch, newTip))) {
    return { ok: false, kind: "failed", message: `Couldn't move ${branchName} to the rebased tip` };
  }
  return { ok: true };
}

/**
 * Why a rewrite stopped: a conflict leaves unmerged paths; anything else (a
 * signer that refused, a lock) is a failure whose stderr says what.
 */
async function failureKind(worktreePath: string): Promise<"conflict" | "failed"> {
  const unmerged = await unmergedPaths(worktreePath).catch(() => []);
  return unmerged.length > 0 ? "conflict" : "failed";
}

/**
 * Rebuild the agent branch on `baseSha` without the commits in `drop`. Commits
 * not among the proposed ones are ignored; the result says how many dropped.
 * On a conflict or failure the branch is put back where it was.
 */
export async function dropProposedCommits(
  branch: AgentBranch,
  baseSha: string,
  drop: ReadonlySet<string>,
): Promise<
  | { readonly kind: "dropped"; readonly count: number }
  | { readonly kind: "none-matched" }
  | { readonly kind: "conflict" | "failed"; readonly message: string }
> {
  const { worktreePath, branchName } = branch;
  const all = await proposedShas(branch, baseSha);
  const keep = all.filter((sha) => !drop.has(sha));
  if (keep.length === all.length) return { kind: "none-matched" };
  const oldTip = await resolveRef(worktreePath, branchName);
  if (oldTip === null) return { kind: "failed", message: "Couldn't read the agent branch" };

  const restore = async () => {
    await abortCherryPick(worktreePath);
    await forceBranch(worktreePath, branchName, oldTip);
    await restoreAgentBranch(branch);
  };
  const detached = await checkoutDetached(worktreePath, baseSha);
  if (!detached.ok) {
    await restore();
    return { kind: "failed", message: detached.stderr || "Couldn't detach the worktree" };
  }
  for (const sha of keep) {
    const picked = await cherryPick(worktreePath, sha);
    if (!picked.ok) {
      const kind = await failureKind(worktreePath);
      await restore();
      return { kind, message: picked.stderr || "git cherry-pick failed" };
    }
  }
  const newTip = await resolveRef(worktreePath, "HEAD");
  const moved = newTip === null ? null : await forceBranch(worktreePath, branchName, newTip);
  if (!moved?.ok || !(await checkout(worktreePath, branchName)).ok) {
    await restore();
    return { kind: "failed", message: moved?.stderr || "Couldn't move the agent branch" };
  }
  return { kind: "dropped", count: all.length - keep.length };
}

/**
 * Rewind the agent branch to `baseSha`, discarding its commits and any
 * uncommitted work: what clearing the conversation means. Clears what a killed
 * agent turn or push leaves in the way (lock files, a merge, rebase or
 * cherry-pick in progress, a detached HEAD) and logs loudly if the rewind
 * still doesn't land, since the next turn would otherwise resurrect the
 * discarded commits.
 */
export async function resetToBase(branch: AgentBranch, baseSha: string): Promise<void> {
  const { worktreePath, branchName } = branch;
  const dirs = await gitDirs(worktreePath);
  if (!dirs) {
    logError("chat-clear", `${worktreePath} is not a readable worktree`);
    return;
  }
  for (const lock of ["index.lock", "HEAD.lock"]) {
    const lockPath = join(dirs.gitDir, lock);
    if (existsSync(lockPath)) await rm(lockPath, { force: true }).catch(() => {});
  }
  await abortMerge(worktreePath);
  await abortRebase(worktreePath);
  await abortCherryPick(worktreePath);
  // With HEAD detached, `reset --hard` would move HEAD and leave the branch.
  if ((await attachedBranch(worktreePath)) !== `refs/heads/${branchName}`) {
    await attachHead(worktreePath, branchName);
  }
  const reset = await resetHard(worktreePath, baseSha);
  if (!reset.ok)
    logError("chat-clear", `reset --hard ${baseSha} failed in ${worktreePath}:`, reset.stderr);
  await cleanUntracked(worktreePath);
  const finalSha = await resolveRef(worktreePath, "HEAD");
  if (finalSha !== baseSha) {
    logError(
      "chat-clear",
      `worktree rewind did not land: expected=${baseSha} got=${finalSha} worktree=${worktreePath}`,
    );
  }
}
