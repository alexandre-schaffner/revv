// ── GitOps ───────────────────────────────────────────────────────────────
//
// Shared git-push primitives + the small set of tagged errors that go with
// them. Lifted from `ChatChangesPush.ts` so the new-PR session pipeline
// (`NewPrSessionService`) can reuse the same push surface — same git
// command shapes, same error semantics, same security-conscious helpers
// (no token leaks in `.git/config`, flag-like argument rejection).
//
// Scope is deliberately narrow: only the helpers that both flows need.
// Chat-specific operations (merge-then-push, cherry-pick, conflict
// resolution, force-with-lease against an existing branch) stay in
// `ChatChangesPush.ts` since they require the chat-session state machine.

import { Data } from "effect";
import { runGitCapture, spawnGit } from "./git-runner";

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
