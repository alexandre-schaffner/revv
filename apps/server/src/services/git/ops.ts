// The git command surface: every git command Revv runs is one of these. They
// share one convention: a command whose failure is an outcome the caller acts
// on (a merge that conflicts, a fetch that can't reach the remote) returns a
// `GitAttempt`; a read returns its parsed answer, or `null` / `[]` when git
// can't give one. Nothing here decides what a failure means for a feature.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type LineCounts,
  type NameStatusEntry,
  parseNameStatusZ,
  parseNumstat,
  parseWorktreeList,
  type WorktreeEntry,
} from "./parse";
import {
  ensureSignalHandlersInstalled,
  type GitAttempt,
  type GitPolicy,
  gitAttempt,
  gitSucceeds,
  killStaleCloneProcesses,
  runGit,
} from "./runner";

/**
 * Traversal flags that define an agent branch's *proposed commits*, the
 * commits the agent authored on top of the PR head.
 *
 * `base..branch` alone walks both parents of a merge commit, so a single
 * `git merge origin/main` on the branch drags the entire base history into
 * the range as bogus "proposed commits". `--first-parent` stays on the
 * branch's own line; `--no-merges` drops the merge commits themselves. Every
 * enumeration of the range — display, push count, cherry-pick order,
 * discard/rebuild, prune — uses these flags so they never disagree.
 */
export const PROPOSED_COMMIT_RANGE_FLAGS = ["--first-parent", "--no-merges"] as const;

export function isValidSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(sha);
}

/**
 * Refuse an identifier git would read as a flag. Escaping with `--` is not
 * reliable across subcommands, so a leading `-` is refused outright.
 */
export function assertNotFlagLike(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new Error(`refusing to use ${label} that looks like a flag: ${value}`);
  }
}

/**
 * Every command below that writes commits writes ones that end up on the
 * user's branches: the chat push's merge and cherry-picks, the agent branch's
 * rebuilds (pushed with it later), base sync and stack rebase. They are signed
 * the way the user signs.
 */
const PUSHED_COMMITS: GitPolicy = { signing: "user" };

const lines = (out: string) => out.split("\n").filter((line) => line.length > 0);

/**
 * Whether the worktree has no uncommitted *tracked* change: modifications,
 * deletions, staged work or conflicts. Untracked files are runtime artifacts,
 * not part of anything a push would carry.
 */
export async function workingTreeIsClean(
  cwd: string,
): Promise<{ readonly clean: boolean; readonly output: string }> {
  const out = await runGit(cwd, ["status", "--porcelain=v1"], 15_000);
  // Each line starts with a two-column status, often a space: never trim it.
  const blocking = lines(out)
    .filter((line) => !line.startsWith("??"))
    .join("\n");
  return { clean: blocking.length === 0, output: blocking };
}

export async function unmergedPaths(cwd: string): Promise<string[]> {
  return lines(await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"], 10_000));
}

/**
 * Tracked paths with an unstaged change the in-progress merge did not make:
 * the work `git merge --abort` would destroy beyond recovery.
 *
 * A conflicted merge leaves exactly two traces: the conflicts, and the hunks
 * it auto-merged, which git stages. Git refuses to start a merge over a dirty
 * path, so any other unstaged change was made in the working tree afterwards.
 */
export async function unstagedOutsideMerge(cwd: string): Promise<string[]> {
  const [unstaged, conflicted] = await Promise.all([
    runGit(cwd, ["diff", "--name-only"], 10_000),
    unmergedPaths(cwd),
  ]);
  const conflicts = new Set(conflicted);
  return lines(unstaged).filter((file) => !conflicts.has(file));
}

/**
 * Asks git, never `<worktree>/.git/MERGE_HEAD`: in a linked worktree `.git`
 * is a file pointing at the real gitdir, so the filesystem probe always says
 * no merge is in progress.
 */
export async function isMergeInProgress(cwd: string): Promise<boolean> {
  return gitSucceeds(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
}

/** Asks git where the rebase state lives, for the same reason as {@link isMergeInProgress}. */
export async function isRebaseInProgress(cwd: string): Promise<boolean> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const r = await gitAttempt(cwd, ["rev-parse", "--git-path", dir], 10_000);
    const path = r.stdout.trim();
    if (r.ok && path.length > 0 && existsSync(resolve(cwd, path))) return true;
  }
  return false;
}

export async function gitDirs(
  cwd: string,
): Promise<{ readonly gitDir: string; readonly commonDir: string } | null> {
  const r = await gitAttempt(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    10_000,
  );
  const [gitDir, commonDir] = lines(r.stdout).map((l) => l.trim());
  return r.ok && gitDir && commonDir ? { gitDir, commonDir } : null;
}

/** `refs/heads/<name>` HEAD is attached to, or null when detached. */
export async function attachedBranch(cwd: string): Promise<string | null> {
  const r = await gitAttempt(cwd, ["symbolic-ref", "-q", "HEAD"], 10_000);
  const ref = r.stdout.trim();
  return r.ok && ref.length > 0 ? ref : null;
}

export async function isGitRepo(path: string): Promise<boolean> {
  return gitSucceeds(path, ["rev-parse", "--git-dir"]);
}

export async function originUrl(path: string): Promise<string | null> {
  const r = await gitAttempt(path, ["remote", "get-url", "origin"], 10_000);
  return r.ok ? r.stdout.trim() : null;
}

export async function remotes(
  path: string,
): Promise<ReadonlyArray<{ readonly name: string; readonly url: string }>> {
  const r = await gitAttempt(path, ["remote", "-v"], 10_000);
  const seen = new Set<string>();
  const found: { name: string; url: string }[] = [];
  for (const line of lines(r.ok ? r.stdout : "")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    const [, name, url] = match ?? [];
    if (!name || !url || seen.has(`${name}\0${url}`)) continue;
    seen.add(`${name}\0${url}`);
    found.push({ name, url });
  }
  return found;
}

export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  const r = await gitAttempt(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 10_000);
  const sha = r.stdout.trim();
  return r.ok && sha.length > 0 ? sha : null;
}

export async function commitExists(cwd: string, sha: string): Promise<boolean> {
  return gitSucceeds(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
}

export async function isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
  return gitSucceeds(cwd, ["merge-base", "--is-ancestor", ancestor, of], 30_000);
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  const r = await gitAttempt(cwd, ["merge-base", a, b], 30_000);
  const sha = r.stdout.trim();
  return r.ok && sha.length > 0 ? sha : null;
}

export async function commitParents(cwd: string, rev: string): Promise<string[]> {
  const r = await gitAttempt(cwd, ["rev-list", "--parents", "-n", "1", rev], 10_000);
  return r.ok ? r.stdout.trim().split(/\s+/).slice(1) : [];
}

/** Counts merge commits too, unlike {@link proposedCommitCount}. */
export async function revListCount(cwd: string, range: string): Promise<number | null> {
  const r = await gitAttempt(cwd, ["rev-list", "--count", range], 30_000);
  const n = Number.parseInt(r.stdout.trim(), 10);
  return r.ok && Number.isFinite(n) ? n : null;
}

export async function proposedCommitCount(cwd: string, range: string): Promise<number | null> {
  const r = await gitAttempt(
    cwd,
    ["rev-list", "--count", ...PROPOSED_COMMIT_RANGE_FLAGS, range],
    10_000,
  );
  const n = Number.parseInt(r.stdout.trim(), 10);
  return r.ok && Number.isFinite(n) ? n : null;
}

/** The proposed commits in `range`, oldest first (cherry-pick order). Throws when git can't list them. */
export async function proposedCommitShas(cwd: string, range: string): Promise<string[]> {
  const out = await runGit(
    cwd,
    ["rev-list", "--reverse", ...PROPOSED_COMMIT_RANGE_FLAGS, range],
    10_000,
  );
  return lines(out).map((sha) => sha.trim());
}

export interface CommitSummary {
  readonly sha: string;
  readonly subject: string;
  readonly committedAt: string;
  /** Paths the commit touched against its parent. */
  readonly files: string[];
}

/** The proposed commits in `range`, newest first, as `git log` shows them. Throws when git can't list them. */
export async function proposedCommitLog(cwd: string, range: string): Promise<CommitSummary[]> {
  const out = await runGit(
    cwd,
    [
      "log",
      ...PROPOSED_COMMIT_RANGE_FLAGS,
      "--name-only",
      range,
      "--pretty=format:%x1e%H%x09%s%x09%aI",
    ],
    10_000,
  );
  return out.split("\x1e").flatMap((record) => {
    const [header, ...files] = lines(record);
    const [sha, subject, committedAt] = header?.split("\t") ?? [];
    return sha && subject !== undefined && committedAt
      ? [{ sha, subject, committedAt, files }]
      : [];
  });
}

/** What a commit changed against its first parent, renames detected. Throws when git can't read it. */
export async function commitChanges(
  cwd: string,
  sha: string,
): Promise<ReadonlyArray<NameStatusEntry>> {
  return parseNameStatusZ(
    await runGit(
      cwd,
      ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "-M", sha],
      15_000,
    ),
  );
}

/** A commit's patch against its first parent. Throws when git can't read it. */
export async function commitPatch(cwd: string, sha: string): Promise<string> {
  return runGit(cwd, ["show", "--patch", "--pretty=format:", sha], 15_000);
}

export async function showFile(cwd: string, rev: string, path: string): Promise<string | null> {
  const r = await gitAttempt(cwd, ["show", `${rev}:${path}`], 10_000);
  return r.ok ? r.stdout : null;
}

/** The size in bytes of the blob `<rev>:<path>`, or null when there is none. */
export async function blobSize(cwd: string, rev: string, path: string): Promise<number | null> {
  const r = await gitAttempt(cwd, ["cat-file", "-s", `${rev}:${path}`], 30_000);
  const size = Number.parseInt(r.stdout.trim(), 10);
  return r.ok && Number.isFinite(size) ? size : null;
}

/** The content of the blob `<rev>:<path>`. Throws when git can't read it. */
export async function blobContent(cwd: string, rev: string, path: string): Promise<string> {
  return runGit(cwd, ["cat-file", "-p", `${rev}:${path}`], 60_000);
}

/** Every tracked path at `rev`. Throws when git can't list them. */
export async function listTrackedFiles(cwd: string, rev = "HEAD"): Promise<string[]> {
  const out = await runGit(cwd, ["ls-tree", "-r", "--name-only", "-z", rev], 10_000);
  return out.split("\0").filter((path) => path.length > 0);
}

/** Full ref names under `prefixes`; empty when they can't be listed. */
export async function listRefs(cwd: string, prefixes: readonly string[]): Promise<string[]> {
  const r = await gitAttempt(cwd, ["for-each-ref", "--format=%(refname)", ...prefixes], 15_000);
  return r.ok ? lines(r.stdout).map((ref) => ref.trim()) : [];
}

export async function updateRef(cwd: string, ref: string, sha: string): Promise<GitAttempt> {
  return gitAttempt(cwd, ["update-ref", ref, sha], 15_000);
}

/** Best-effort; a missing ref is fine. */
export async function deleteRef(cwd: string, ref: string): Promise<boolean> {
  return gitSucceeds(cwd, ["update-ref", "-d", ref], 15_000);
}

/** Best-effort; a missing branch is fine. */
export async function deleteBranch(cwd: string, branch: string): Promise<boolean> {
  return gitSucceeds(cwd, ["branch", "-D", branch], 15_000);
}

export async function diffNameStatus(
  cwd: string,
  base: string,
  head: string,
): Promise<ReadonlyArray<NameStatusEntry>> {
  return parseNameStatusZ(
    await runGit(
      cwd,
      ["-c", "core.quotePath=false", "diff", "--find-renames", "--name-status", "-z", base, head],
      30_000,
    ),
  );
}

/**
 * `core.quotePath` is off so non-ASCII paths come back verbatim and key the
 * same as {@link diffNameStatus}'s.
 */
export async function diffNumstat(
  cwd: string,
  base: string,
  head: string,
): Promise<ReadonlyMap<string, LineCounts>> {
  return parseNumstat(
    await runGit(
      cwd,
      ["-c", "core.quotePath=false", "diff", "--find-renames", "--numstat", base, head],
      30_000,
    ),
  );
}

export async function diffPatchForPath(
  cwd: string,
  base: string,
  head: string,
  path: string,
): Promise<string> {
  return runGit(cwd, ["diff", "--find-renames", "--unified=80", base, head, "--", path], 30_000);
}

export async function changedPaths(
  cwd: string,
  a: string,
  b: string,
  pathspec: string,
): Promise<string[]> {
  const r = await gitAttempt(cwd, ["diff", "--name-only", a, b, "--", pathspec], 30_000);
  return r.ok ? lines(r.stdout) : [];
}

export async function hasConflictMarkers(
  cwd: string,
  rev: string,
  paths: readonly string[],
): Promise<boolean> {
  if (paths.length === 0) return false;
  const r = await gitAttempt(
    cwd,
    ["grep", "-l", "-E", "^(<{7}|>{7})( |$)", rev, "--", ...paths],
    30_000,
  );
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * `git merge-tree --write-tree` of `head` into `base`, touching no index or
 * worktree. Exit 0 is a clean merge, 1 a conflicted one; anything else is a
 * failure (no merge base, or a git older than 2.38).
 */
export async function mergeTreeWriteTree(
  cwd: string,
  base: string,
  head: string,
): Promise<GitAttempt> {
  return gitAttempt(
    cwd,
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, head],
    60_000,
  );
}

export async function fetch(
  cwd: string,
  url: string,
  refspecs: readonly string[],
  opts: { readonly deepen?: number; readonly timeoutMs?: number } = {},
): Promise<GitAttempt> {
  return gitAttempt(
    cwd,
    [
      "fetch",
      "--no-tags",
      ...(opts.deepen !== undefined ? [`--deepen=${opts.deepen}`] : []),
      url,
      ...refspecs,
    ],
    opts.timeoutMs ?? 120_000,
  );
}

export async function checkout(cwd: string, ref: string): Promise<GitAttempt> {
  return gitAttempt(cwd, ["checkout", ref], 30_000);
}

/**
 * Move HEAD to `ref` detached; no local branch is created or moved. Revv's
 * clones share branches with every other worktree of the repository (the
 * user's own included), and `checkout -B <branch>` fails outright while
 * another worktree has that branch checked out.
 */
export async function checkoutDetached(cwd: string, ref: string): Promise<GitAttempt> {
  return gitAttempt(cwd, ["checkout", "--detach", ref], 30_000);
}

export async function forceBranch(cwd: string, branch: string, sha: string): Promise<GitAttempt> {
  return gitAttempt(cwd, ["branch", "-f", branch, sha], 15_000);
}

/** Point HEAD at `refs/heads/<branch>` without touching the working tree. */
export async function attachHead(cwd: string, branch: string): Promise<boolean> {
  return gitSucceeds(cwd, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
}

export async function resetHard(cwd: string, rev: string): Promise<GitAttempt> {
  return gitAttempt(cwd, ["reset", "--hard", rev], 30_000);
}

/** Best-effort removal of untracked files and directories. */
export async function cleanUntracked(cwd: string): Promise<boolean> {
  return gitSucceeds(cwd, ["clean", "-fd"], 30_000);
}

/**
 * Merge `ref` into HEAD. `message` names the merge commit, which matters on
 * a detached HEAD, where git would otherwise write "into HEAD".
 */
export async function merge(
  cwd: string,
  ref: string,
  opts: { readonly message: string; readonly noFastForward?: boolean; readonly timeoutMs?: number },
): Promise<GitAttempt> {
  return gitAttempt(
    cwd,
    ["merge", ...(opts.noFastForward ? ["--no-ff"] : []), "--no-edit", "-m", opts.message, ref],
    opts.timeoutMs ?? 60_000,
    PUSHED_COMMITS,
  );
}

export async function cherryPick(cwd: string, sha: string): Promise<GitAttempt> {
  return gitAttempt(cwd, ["cherry-pick", sha], 60_000, PUSHED_COMMITS);
}

/**
 * `git rebase --onto onto upstream tip`, leaving HEAD detached at the result.
 * The rebase never moves another ref, whatever the user's own config says:
 * the refs belong to the other worktrees of the clone.
 */
export async function rebaseOnto(
  cwd: string,
  onto: string,
  upstream: string,
  tip: string,
  timeoutMs = 60_000,
): Promise<GitAttempt> {
  return gitAttempt(
    cwd,
    [
      "-c",
      "rebase.updateRefs=false",
      "-c",
      "rebase.autoStash=false",
      "rebase",
      "--no-autosquash",
      "--onto",
      onto,
      upstream,
      tip,
    ],
    timeoutMs,
    PUSHED_COMMITS,
  );
}

export async function abortMerge(cwd: string): Promise<boolean> {
  return gitSucceeds(cwd, ["merge", "--abort"], 30_000);
}

export async function abortRebase(cwd: string): Promise<boolean> {
  return gitSucceeds(cwd, ["rebase", "--abort"], 30_000);
}

export async function abortCherryPick(cwd: string): Promise<boolean> {
  return gitSucceeds(cwd, ["cherry-pick", "--abort"], 30_000);
}

export async function listWorktrees(clonePath: string): Promise<WorktreeEntry[]> {
  const r = await gitAttempt(clonePath, ["worktree", "list", "--porcelain"], 15_000);
  return r.ok ? parseWorktreeList(r.stdout) : [];
}

/** A worktree at `path` on `branch`, created or reset to `sha`. */
export async function addWorktreeOnBranch(
  clonePath: string,
  path: string,
  branch: string,
  sha: string,
): Promise<GitAttempt> {
  return gitAttempt(clonePath, ["worktree", "add", "-B", branch, path, sha], 120_000);
}

export async function addDetachedWorktree(
  clonePath: string,
  path: string,
  sha: string,
  timeoutMs = 5 * 60_000,
): Promise<GitAttempt> {
  return gitAttempt(clonePath, ["worktree", "add", "--detach", path, sha], timeoutMs);
}

/**
 * Best-effort: remove the worktree at `path`, including its registration when
 * the directory is already gone. This is the only way Revv drops a worktree:
 * `git worktree prune` would also drop the user's own worktrees whose drive
 * isn't mounted, because the clone may be their repository.
 */
export async function removeWorktree(clonePath: string, path: string): Promise<boolean> {
  return gitSucceeds(clonePath, ["worktree", "remove", "--force", path], 15_000);
}

export async function shallowClone(
  url: string,
  dest: string,
  authConfig: readonly string[],
  timeoutMs: number,
): Promise<GitAttempt> {
  return gitAttempt(undefined, [...authConfig, "clone", "--depth=1", url, dest], timeoutMs);
}

/**
 * Called once at boot, before the first clone: kill git processes a previous
 * server lifetime orphaned in the clone directory, and make sure this
 * lifetime's are killed when it exits.
 */
export async function reapOrphanedGitProcesses(): Promise<void> {
  ensureSignalHandlersInstalled();
  await killStaleCloneProcesses();
}
