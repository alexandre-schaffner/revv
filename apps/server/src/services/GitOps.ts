// ── GitOps ───────────────────────────────────────────────────────────────
//
// Shared git command surface for the chat-push / new-PR-session flows, plus
// the small set of tagged errors that go with them. This is the Local Git
// module seam for command shapes that don't need RepoCloneService worktree
// acquisition: same git args, same timeouts, same security-conscious helpers
// (no token leaks in `.git/config`, flag-like argument rejection).
//
// Chat-session orchestration (merge state machine, conflict handling, leases,
// and Effect error mapping) stays in `ChatChangesPush.ts`; raw subprocess
// plumbing stays behind this module.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Data } from "effect";
import { runGit, runGitBestEffort, runGitCapture, spawnGit } from "./git-runner";

// ── Errors ────────────────────────────────────────────────────────────────

export class GitOperationError extends Data.TaggedError("GitOperationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PushRejectedError extends Data.TaggedError("PushRejectedError")<{
  readonly message: string;
}> {}

export class RefAlreadyExistsError extends Data.TaggedError("RefAlreadyExistsError")<{
  readonly ref: string;
}> {}

export class InvalidBranchNameError extends Data.TaggedError("InvalidBranchNameError")<{
  readonly message: string;
}> {}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Loose validation for a git SHA — abbreviated or full. */
export function isValidSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(sha);
}

/**
 * Guard against `git` accidentally treating a positional argument as a
 * flag. Branch names, ref names, and other user-supplied identifiers
 * that start with `-` are refused outright — the safer alternative
 * (escaping or `--`) is fragile across git's many subcommands.
 */
export function assertNotFlagLike(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new Error(`refusing to use ${label} that looks like a flag: ${value}`);
  }
}

export async function statusPorcelain(worktreePath: string): Promise<string> {
  return (await runGitCapture(["status", "--porcelain=v1"], worktreePath, 15_000)).trim();
}

// Block the push on any uncommitted *tracked* change — modifications,
// deletions, staged work, or unmerged conflict state — but ignore untracked
// files (`??`). Untracked entries are runtime artifacts that aren't in the
// user-reviewed proposed-changes diff.
export async function workingTreeIsClean(worktreePath: string): Promise<{
  clean: boolean;
  output: string;
}> {
  const raw = await statusPorcelain(worktreePath);
  const blocking = raw
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("??"))
    .join("\n");
  return { clean: blocking.length === 0, output: blocking };
}

export async function unmergedPaths(worktreePath: string): Promise<string[]> {
  const out = (
    await runGitCapture(["diff", "--name-only", "--diff-filter=U"], worktreePath, 10_000)
  ).trim();
  if (out.length === 0) return [];
  return out.split("\n").filter((file) => file.length > 0);
}

export async function revListCount(worktreePath: string, range: string): Promise<string> {
  return (await runGitCapture(["rev-list", "--count", range], worktreePath, 10_000)).trim();
}

export async function revListReverse(worktreePath: string, range: string): Promise<string[]> {
  const out = (await runGitCapture(["rev-list", "--reverse", range], worktreePath, 10_000)).trim();
  if (out.length === 0) return [];
  return out
    .split("\n")
    .map((sha) => sha.trim())
    .filter(Boolean);
}

export async function revParse(
  worktreePath: string,
  ref: string,
  timeoutMs: number,
): Promise<string> {
  return (await runGitCapture(["rev-parse", ref], worktreePath, timeoutMs)).trim();
}

export async function fetchRefspec(
  worktreePath: string,
  authedUrl: string,
  refspec: string,
): Promise<void> {
  await runGit(["fetch", authedUrl, refspec], worktreePath);
}

export async function checkoutBranch(worktreePath: string, branch: string): Promise<void> {
  await runGit(["checkout", branch], worktreePath);
}

export async function checkoutNewBranchFromRef(
  worktreePath: string,
  branch: string,
  startRef: string,
): Promise<void> {
  await runGit(["checkout", "-B", branch, startRef], worktreePath);
}

export async function forceBranchTo(
  worktreePath: string,
  branch: string,
  sha: string,
): Promise<void> {
  await runGit(["branch", "-f", branch, sha], worktreePath);
}

export async function merge(
  worktreePath: string,
  branch: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await spawnGit(["merge", "--no-edit", branch], {
    cwd: worktreePath,
    timeoutMs: 60_000,
    captureStdout: false,
  });
  return {
    ok: !result.timedOut && result.exitCode === 0,
    stderr: result.stderrTail,
  };
}

export async function cherryPick(
  worktreePath: string,
  sha: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await spawnGit(["cherry-pick", sha], {
    cwd: worktreePath,
    timeoutMs,
    captureStdout: false,
  });
  return {
    ok: !result.timedOut && result.exitCode === 0,
    stderr: result.stderrTail,
  };
}

export async function rebaseOnto(
  worktreePath: string,
  onto: string,
  upstream: string,
  branch: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await spawnGit(["rebase", "--onto", onto, upstream, branch], {
    cwd: worktreePath,
    timeoutMs: 60_000,
    captureStdout: false,
  });
  return {
    ok: !result.timedOut && result.exitCode === 0,
    stderr: result.stderrTail,
  };
}

export async function abortMerge(worktreePath: string): Promise<boolean> {
  return runGitBestEffort(["merge", "--abort"], worktreePath, 15_000);
}

export async function abortRebase(worktreePath: string): Promise<boolean> {
  return runGitBestEffort(["rebase", "--abort"], worktreePath, 15_000);
}

export async function abortCherryPick(worktreePath: string): Promise<boolean> {
  return runGitBestEffort(["cherry-pick", "--abort"], worktreePath, 15_000);
}

export async function checkoutBranchBestEffort(
  worktreePath: string,
  branch: string,
  timeoutMs: number,
): Promise<boolean> {
  return runGitBestEffort(["checkout", branch], worktreePath, timeoutMs);
}

export async function forceBranchToBestEffort(
  worktreePath: string,
  branch: string,
  sha: string,
  timeoutMs: number,
): Promise<boolean> {
  return runGitBestEffort(["branch", "-f", branch, sha], worktreePath, timeoutMs);
}

export function isMergeInProgress(worktreePath: string): boolean {
  return existsSync(join(worktreePath, ".git", "MERGE_HEAD"));
}

/**
 * Read the remote SHA for `refs/heads/{branch}` via `git ls-remote`.
 * Returns null if the branch does not exist on the remote, the SHA looks
 * malformed, or git returned an empty body.
 *
 * Used as:
 *   - The lease guard for force-with-lease pushes against an existing
 *     branch (chat flow).
 *   - The idempotency check before creating a new branch on the remote
 *     (new-PR flow): "if the ref already exists, the previous push
 *     succeeded — short-circuit to success".
 */
export async function lsRemoteHead(
  clonePath: string,
  authedUrl: string,
  branch: string,
): Promise<string | null> {
  const out = await runGitCapture(
    ["ls-remote", authedUrl, `refs/heads/${branch}`],
    clonePath,
    30_000,
  );
  const line = out.trim().split("\n")[0];
  if (!line) return null;
  const tab = line.indexOf("\t");
  if (tab < 0) return null;
  const sha = line.slice(0, tab).trim();
  return isValidSha(sha) ? sha : null;
}

/**
 * Push a local branch to a brand-new remote ref. No lease, no merge —
 * just create the remote branch. When `force=true`, overwrites an
 * existing remote ref; default behaviour rejects with "already exists"
 * which the caller can map to a structured `RefAlreadyExistsError`.
 *
 * `authedUrl` carries the access token in the URL so it never lands in
 * `.git/config`. The caller is responsible for constructing the URL with
 * a fresh, scoped token.
 */
export async function pushNewBranch(
  worktreePath: string,
  authedUrl: string,
  localRef: string,
  remoteBranch: string,
  force: boolean,
): Promise<{ ok: boolean; stderr: string }> {
  const args = ["push"];
  if (force) args.push("--force");
  args.push(authedUrl, `${localRef}:refs/heads/${remoteBranch}`);
  const result = await spawnGit(args, {
    cwd: worktreePath,
    timeoutMs: 120_000,
    captureStdout: false,
  });
  return {
    ok: !result.timedOut && result.exitCode === 0,
    stderr: result.stderrTail,
  };
}

/**
 * Push a local branch to an existing remote ref with `--force-with-lease`.
 * The lease checks the remote tip against `expectedRemoteSha` — if the
 * remote has moved, git rejects the push and the caller treats it as
 * `remote-changed` (re-fetch and ask the user how to proceed).
 *
 * Used by the chat-push flow when the agent commits land on top of the
 * PR's source branch. New-PR sessions don't use this (their branch is
 * brand new), but it lives here so both flows share one push module.
 */
export async function pushWithLease(
  worktreePath: string,
  authedUrl: string,
  localRef: string,
  remoteBranch: string,
  expectedRemoteSha: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await spawnGit(
    [
      "push",
      `--force-with-lease=refs/heads/${remoteBranch}:${expectedRemoteSha}`,
      authedUrl,
      `${localRef}:refs/heads/${remoteBranch}`,
    ],
    { cwd: worktreePath, timeoutMs: 120_000, captureStdout: false },
  );
  return {
    ok: !result.timedOut && result.exitCode === 0,
    stderr: result.stderrTail,
  };
}

/**
 * Plain fast-forward push when there is no remote ref to lease against
 * (e.g. a freshly-fetched branch that's known to be a strict ancestor of
 * local). Same arg shape as `pushWithLease` minus the lease, so both
 * call sites can share the same outcome handling.
 */
export async function pushFastForward(
  worktreePath: string,
  authedUrl: string,
  localRef: string,
  remoteBranch: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await spawnGit(["push", authedUrl, `${localRef}:refs/heads/${remoteBranch}`], {
    cwd: worktreePath,
    timeoutMs: 120_000,
    captureStdout: false,
  });
  return {
    ok: !result.timedOut && result.exitCode === 0,
    stderr: result.stderrTail,
  };
}
