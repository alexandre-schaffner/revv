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
//
// Two things here are NOT plumbing and are called out so the boundary above
// stays honest:
//
//   • `resolveProposedBaseSha` is policy — it decides which of two candidate
//     PR heads counts as the agent's baseline. It lives here because the rule
//     is expressed purely in terms of git ranges and has four callers across
//     two route files and a service; putting it in any one of them would make
//     the other three import from a peer.
//   • Reading git's stderr (`classifyPushFailure`, `redactGitAuth`) is
//     interpretation, not invocation. It lives here for the same reason and is
//     kept in its own section at the bottom of the file.
//
// Anything else that wants to reason about *meaning* rather than *arguments*
// belongs in its caller.

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

/**
 * Traversal flags that define an agent branch's *proposed commits* — the
 * commits the agent authored on top of the PR head that a reviewer can
 * cherry-pick or discard.
 *
 * `prHeadSha..branch` on its own walks BOTH parents of any merge commit. If
 * the agent (or the user, through the agent) ran `git merge origin/main` to
 * bring the branch up to date, that single merge drags the *entire* base
 * branch history into the range — hundreds of unrelated commits surface as
 * bogus "proposed commits" (the insane brand-new-session list). `--first-parent`
 * keeps traversal on the agent branch's own line so merged-in base history is
 * excluded; `--no-merges` drops the merge commits themselves (plumbing, not
 * proposed content). Every enumeration of the proposed-commit range — the
 * display list, the push ahead-count, the push cherry-pick order, and the
 * discard/rebuild list — MUST share these flags so they never disagree about
 * what "the agent's commits" are.
 */
export const PROPOSED_COMMIT_RANGE_FLAGS = ["--first-parent", "--no-merges"] as const;

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

/**
 * Tracked paths carrying an **unstaged** change that the in-progress merge did
 * not produce — the work `git merge --abort` would destroy with no way back.
 *
 * `merge --abort` hard-resets to the pre-merge HEAD, and git cannot reconstruct
 * uncommitted worktree changes that were already there when the merge started.
 * There is no reflog for unstaged work, so "is this dirt the merge's, or
 * someone's?" has to be answered before aborting, not after.
 *
 * A conflicted merge leaves its own evidence in exactly two shapes: the
 * conflicts themselves, and the hunks git auto-merged for us — which it
 * *stages*, so they do not show up as unstaged at all. Everything left over is
 * an edit made in the working tree, which the merge cannot be responsible for,
 * because git refuses to start a merge that would touch a dirty path in the
 * first place.
 *
 * So: unstaged changes (`git diff`, worktree against index) minus the conflict
 * set. Untracked files never appear in either, which is correct — `merge
 * --abort` leaves them alone.
 */
export async function unstagedOutsideMerge(worktreePath: string): Promise<string[]> {
  const [unstaged, conflicted] = await Promise.all([
    runGitCapture(["diff", "--name-only"], worktreePath, 10_000),
    unmergedPaths(worktreePath),
  ]);
  const conflicts = new Set(conflicted);
  return unstaged
    .trim()
    .split("\n")
    .filter((file) => file.length > 0 && !conflicts.has(file));
}

/**
 * Resolve the baseline commit of a PR's proposed-commit range — the PR head the
 * agent branch is actually built on.
 *
 * The obvious baseline, the chat session's own `prHeadSha`, goes stale. That
 * row is keyed on the head SHA the session started at and is never rewritten
 * when the PR head moves; `RepoClone.acquirePrWorktree` meanwhile resets the
 * worktree onto the head *it* was asked for. After a rebase or force-push the
 * branch sits on a head the session has never heard of, and `staleHead..HEAD`
 * reports the PR's entire rewritten history as "proposed commits" — 40 phantom
 * commits in a brand-new chat, a Push pill offering to push other people's
 * work, and a discard/rebuild that would rewind the branch to a dead head.
 *
 * Neither candidate head is reliably the right one (the branch may sit on an
 * intermediate head that is *neither* the session's nor the PR's current one),
 * so pick the **tightest** of the two: whichever attributes fewer commits to
 * the agent. That is safe in both directions because each candidate is a real
 * PR head — any commit a candidate excludes is reachable from a PR head, which
 * makes it part of the PR, not agent work. Ties keep the session baseline, so
 * the historical answer stands wherever the two agree.
 *
 * Falls back to the session baseline whenever nothing can be verified: no
 * known PR head, its object missing from the worktree, or git failing.
 */
export async function resolveProposedBaseSha(params: {
  readonly worktreePath: string;
  /** Tip of the agent branch — `"HEAD"` or the branch name. */
  readonly tip: string;
  /** `chat_sessions.prHeadSha` — the head the session was created at. */
  readonly sessionPrHeadSha: string;
  /** `pull_requests.headSha` — the head GitHub reports today, if known. */
  readonly prHeadSha: string | null;
}): Promise<string> {
  const { worktreePath, tip, sessionPrHeadSha, prHeadSha } = params;
  if (prHeadSha === null || prHeadSha === sessionPrHeadSha || !isValidSha(prHeadSha)) {
    return sessionPrHeadSha;
  }
  if (!(await commitExists(worktreePath, prHeadSha))) return sessionPrHeadSha;

  const [fromPrHead, fromSession] = await Promise.all([
    countProposedOrNull(worktreePath, `${prHeadSha}..${tip}`),
    countProposedOrNull(worktreePath, `${sessionPrHeadSha}..${tip}`),
  ]);
  if (fromPrHead === null) return sessionPrHeadSha;
  if (fromSession === null) return prHeadSha;
  return fromPrHead < fromSession ? prHeadSha : sessionPrHeadSha;
}

/** {@link proposedCommitCount} as a number, or null when git couldn't answer. */
async function countProposedOrNull(worktreePath: string, range: string): Promise<number | null> {
  const raw = await proposedCommitCount(worktreePath, range).catch(() => "");
  const count = Number.parseInt(raw, 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * Count commits in a proposed-commit range (`<base>..<branch>`). Bakes in
 * {@link PROPOSED_COMMIT_RANGE_FLAGS}, so this is NOT a general rev-list count —
 * it deliberately reports only first-parent, non-merge commits. A caller
 * wanting a true commit count must not use this.
 */
export async function proposedCommitCount(worktreePath: string, range: string): Promise<string> {
  return (
    await runGitCapture(
      ["rev-list", "--count", ...PROPOSED_COMMIT_RANGE_FLAGS, range],
      worktreePath,
      10_000,
    )
  ).trim();
}

/**
 * List the SHAs in a proposed-commit range, oldest-first (cherry-pick order).
 * Bakes in {@link PROPOSED_COMMIT_RANGE_FLAGS} — see {@link proposedCommitCount}.
 */
export async function proposedCommitShas(worktreePath: string, range: string): Promise<string[]> {
  const out = (
    await runGitCapture(
      ["rev-list", "--reverse", ...PROPOSED_COMMIT_RANGE_FLAGS, range],
      worktreePath,
      10_000,
    )
  ).trim();
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

export async function commitExists(worktreePath: string, sha: string): Promise<boolean> {
  try {
    await runGit(["cat-file", "-e", `${sha}^{commit}`], worktreePath, 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function fetchRefspec(
  worktreePath: string,
  authedUrl: string,
  refspec: string,
): Promise<void> {
  await runGit(["fetch", authedUrl, refspec], worktreePath);
}

export async function fetchCommit(
  worktreePath: string,
  authedUrl: string,
  sha: string,
): Promise<void> {
  await runGit(["fetch", "--no-tags", authedUrl, sha], worktreePath);
}

export async function diffNameStatusZ(
  worktreePath: string,
  baseRef: string,
  headRef: string,
): Promise<string> {
  return runGitCapture(
    ["diff", "--find-renames", "--name-status", "-z", baseRef, headRef],
    worktreePath,
    30_000,
  );
}

export async function diffPatchForPath(
  worktreePath: string,
  baseRef: string,
  headRef: string,
  path: string,
): Promise<string> {
  return runGitCapture(
    ["diff", "--find-renames", "--unified=80", baseRef, headRef, "--", path],
    worktreePath,
    30_000,
  );
}

/**
 * Per-file added/deleted line counts for the range, computed by git itself
 * (`--numstat`) in a single invocation. Cheap to parse (one integer pair per
 * changed file) — unlike counting the lines of every file's full patch body,
 * which forces a synchronous multi-MB `String.split` on the event loop for
 * large/generated files. Output is `<added>\t<deleted>\t<path>` per line;
 * binary files report `-\t-`.
 *
 * `core.quotePath=false` keeps non-ASCII paths verbatim (git octal-escapes
 * them by default), so they match the verbatim paths that `--name-status -z`
 * emits — otherwise every non-ASCII file would miss the numstat lookup and
 * fall back to counting its patch body.
 */
export async function diffNumstat(
  worktreePath: string,
  baseRef: string,
  headRef: string,
): Promise<string> {
  return runGitCapture(
    ["-c", "core.quotePath=false", "diff", "--find-renames", "--numstat", baseRef, headRef],
    worktreePath,
    30_000,
  );
}

export async function checkoutBranch(worktreePath: string, branch: string): Promise<void> {
  await runGit(["checkout", branch], worktreePath);
}

/**
 * Move the worktree's HEAD to `startRef` **detached** — no local branch is
 * created or moved.
 *
 * The push flows only need a working tree positioned at the PR's source
 * branch so they can merge/cherry-pick the agent commits on top and push
 * `HEAD:refs/heads/{sourceBranch}`. They never need the local branch *name*.
 *
 * Creating it was actively harmful: `git checkout -B {sourceBranch}` fails
 * outright with "fatal: '{branch}' is already used by worktree at ..." when
 * any other worktree of the same repository has that branch checked out —
 * which is the norm once Revv adopts a repo the user is also working in
 * (their own feature-branch worktree holds the PR's source branch). It also
 * littered the user's repo with local branches Revv had no business owning.
 */
export async function checkoutDetachedAt(worktreePath: string, startRef: string): Promise<void> {
  await runGit(["checkout", "--detach", startRef], worktreePath);
}

export async function forceBranchTo(
  worktreePath: string,
  branch: string,
  sha: string,
): Promise<void> {
  await runGit(["branch", "-f", branch, sha], worktreePath);
}

/**
 * Merge `branch` into the current HEAD. `message` overrides git's generated
 * merge-commit subject — needed because HEAD is detached during the push
 * flows, so git would otherwise write "Merge branch 'x' into HEAD" instead
 * of naming the source branch. Ignored by git on a fast-forward.
 */
export async function merge(
  worktreePath: string,
  branch: string,
  message?: string,
): Promise<{ ok: boolean; stderr: string }> {
  const args = ["merge", "--no-edit"];
  if (message !== undefined) args.push("-m", message);
  args.push(branch);
  const result = await spawnGit(args, {
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

/**
 * `true` when the worktree has a merge in progress (MERGE_HEAD present).
 *
 * Asks git instead of probing `<worktree>/.git/MERGE_HEAD`. In a **linked
 * worktree** — which is every per-PR worktree Revv creates — `.git` is a
 * *file* containing `gitdir: …/.git/worktrees/<name>`, not a directory, so
 * the filesystem probe can never find MERGE_HEAD and reports "no merge in
 * progress" unconditionally.
 *
 * That silent `false` is expensive: `performMerge` reads it to tell a merge
 * *conflict* apart from a hard merge *failure*, so every conflict was
 * reported as a hard error — skipping `git merge --abort`, stranding the
 * worktree mid-merge, hiding the conflict-resolution flow, and dead-ending
 * every later push on "worktree has uncommitted changes".
 */
export async function isMergeInProgress(worktreePath: string): Promise<boolean> {
  return runGitBestEffort(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktreePath, 10_000);
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

// ── Push-failure interpretation ──────────────────────────────────────────────

/**
 * Strip the access token out of a string.
 *
 * Everything this module returns as `stderr` is already redacted —
 * {@link spawnGit} applies it to `stderrTail` at the source, so no helper here
 * and no caller of one can leak the token by forgetting. Re-exported for the
 * remaining case: a message the caller assembled itself rather than read off a
 * git result.
 */
export { redactGitAuth } from "./git-runner";

/**
 * What a failed `git push` actually means.
 *
 *   - `auth` — the transport refused us: bad/expired token, missing write
 *     scope, credential prompt suppressed.
 *   - `remote-moved` — git itself declined to send because the update isn't
 *     a fast-forward, or `--force-with-lease` found the remote tip somewhere
 *     other than where we left it. Re-fetching and retrying is the fix, so
 *     this is the only kind worth telling the user to "sync and try again".
 *   - `rejected` — the negotiation succeeded and the *server* said no
 *     (pre-receive hook, protected branch, push rule, quota). Re-syncing
 *     changes nothing; the remote's own message is the only useful thing to
 *     show, so callers must surface `stderr` rather than paraphrase it.
 *
 * The distinction matters because git prints both of the last two with the
 * word "rejected": ` ! [rejected]` is git's own local refusal, whereas
 * ` ! [remote rejected]` is the server's. Matching a bare "rejected" — as
 * this code used to — turns every hook decline into "the branch was updated
 * remotely. Sync the latest changes and try again", which sends the user off
 * to do something that cannot possibly help.
 */
export type PushFailureKind = "auth" | "remote-moved" | "rejected";

/**
 * GitHub's refusal when a push would create or update a file under
 * `.github/workflows/` with a credential that carries no workflow-write
 * authority. Returns the workflow path GitHub named (`null` when it named
 * none), or `null` for any other rejection.
 *
 * Neither of Revv's auth paths can push CI: the GitHub App's permission set
 * is Pull requests RW + Contents RW + Metadata R with no `Workflows: write`,
 * and the OAuth device flow asks for `repo read:org user:email` with no
 * `workflow`. Both refusals arrive as a `[remote rejected]`, and neither
 * wording ("refusing to allow a GitHub App to create or update workflow
 * `x.yml` without `workflows` permission" / "…without `workflow` scope")
 * tells the user anything they can act on — it reads like a server
 * misconfiguration. Agents touch CI constantly, so this is a rejection worth
 * naming rather than echoing.
 *
 * There is no preflight for it: whether a given credential holds the
 * permission is not knowable locally (a self-hosted GHE app may well have it),
 * so the push has to reach GitHub to find out. This only interprets the
 * answer.
 */
export function workflowPermissionRejection(
  stderr: string,
): { readonly path: string | null } | null {
  const lower = stderr.toLowerCase();
  if (!lower.includes("refusing to allow")) return null;
  if (
    !lower.includes("without `workflows` permission") &&
    !lower.includes("without `workflow` scope")
  ) {
    return null;
  }
  // GitHub backticks the path it tripped on: "…update workflow `.github/workflows/ci.yml` without…".
  const named = /workflow `([^`]+)`/i.exec(stderr);
  return { path: named?.[1] ?? null };
}

export function classifyPushFailure(stderr: string): PushFailureKind {
  const lower = stderr.toLowerCase();

  // Checked first: the transport worked and the server declined the ref
  // update itself, so its own text (hook output, push rule, permission
  // wording) is the only thing worth showing. Paraphrasing it as either a
  // sync or a token problem is a guess, and both guesses send the user
  // somewhere useless.
  if (lower.includes("[remote rejected]")) return "rejected";

  // Transport-level refusals. Matched on their surrounding phrasing rather
  // than on bare "403"/"401", which collide with hook output and commit
  // subjects.
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("terminal prompts disabled") ||
    lower.includes("write access to repository not granted") ||
    lower.includes("returned error: 403") ||
    lower.includes("returned error: 401") ||
    lower.includes("403 forbidden") ||
    lower.includes("401 unauthorized")
  ) {
    return "auth";
  }

  if (
    lower.includes("stale info") ||
    lower.includes("non-fast-forward") ||
    lower.includes("fetch first") ||
    lower.includes("[rejected]")
  ) {
    return "remote-moved";
  }

  return "rejected";
}
