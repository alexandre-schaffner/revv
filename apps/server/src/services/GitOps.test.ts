import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortMerge,
  checkoutDetachedAt,
  classifyPushFailure,
  isMergeInProgress,
  merge,
  proposedCommitCount,
  redactGitAuth,
  resolveProposedBaseSha,
  revParse,
  unmergedPaths,
  unstagedOutsideMerge,
  workingTreeIsClean,
} from "./GitOps";

// ── checkoutDetachedAt ───────────────────────────────────────────────────────
//
// Regression cover for the chat-push failure "git checkout failed: fatal:
// '<branch>' is already used by worktree at '<path>'".
//
// The push flows position the per-PR worktree at the PR's source-branch tip
// before merging the agent commits. They used to do that with
// `git checkout -B {sourceBranch} origin/{sourceBranch}`, which git refuses
// whenever another worktree of the same repository already has that branch
// checked out — the normal state once Revv adopts a repo the user is also
// working in. Detaching HEAD has the same effect on the working tree (the
// push targets `HEAD:refs/heads/{sourceBranch}`) without touching branches.

const GIT_ENV: Record<string, string> = {
  ...process.env,
  // Neutralise the developer's own git config. Without this the tests inherit
  // whatever is in `~/.gitconfig` — `commit.gpgsign=true` makes every
  // `commitFile` prompt or fail, and a global `core.hooksPath` runs the
  // developer's hooks inside throwaway fixture repos. CI is unaffected, which
  // is exactly what makes the failure confusing when it happens locally.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Revv Test",
  GIT_AUTHOR_EMAIL: "revv-test@example.com",
  GIT_COMMITTER_NAME: "Revv Test",
  GIT_COMMITTER_EMAIL: "revv-test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function commitFile(cwd: string, name: string, body: string, message: string): string {
  writeFileSync(join(cwd, name), body);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

// A branch name with a slash, matching the shape that surfaced the checkout bug.
const SOURCE_BRANCH = "iam/1-authn-service";
const AGENT_BRANCH = "revv/pr-1";

interface Fixture {
  /** Temp root; delete this to clean up everything below it. */
  base: string;
  origin: string;
  clonePath: string;
  /** The user's own linked worktree, holding `SOURCE_BRANCH`. */
  userWorktree: string;
  /** Revv's per-PR linked worktree, on `AGENT_BRANCH`. */
  revvWorktree: string;
  /** Tip of `SOURCE_BRANCH` as cloned, i.e. the PR head. */
  sourceTip: string;
}

/**
 * The repository shape every test here needs: a bare origin, one clone, and
 * **two linked worktrees** of that clone — the user's and Revv's.
 *
 * Two worktrees is the whole point rather than incidental setup. It is what
 * makes `git checkout -B {sourceBranch}` illegal in Revv's worktree, and it is
 * what makes `.git` a *file* there, which is what defeated the old
 * `existsSync(.git/MERGE_HEAD)` probe.
 */
function makeFixture(prefix: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const origin = join(base, "origin");
  const clonePath = join(base, "clone");
  const userWorktree = join(base, "user-worktree");
  const revvWorktree = join(base, "revv-worktree");

  // Upstream repo with `main` plus the PR's source branch.
  const seed = join(base, "seed");
  git(base, ["init", "-q", "-b", "main", "seed"]);
  commitFile(seed, "README.md", "seed\n", "seed");
  git(seed, ["checkout", "-q", "-b", SOURCE_BRANCH]);
  const sourceTip = commitFile(seed, "authn.ts", "export const authn = 1;\n", "add authn");
  // Back to `main` so the clone below lands on `main`, leaving the source
  // branch free for the two worktrees to fight over.
  git(seed, ["checkout", "-q", "main"]);
  git(base, ["clone", "-q", "--bare", seed, "origin"]);
  git(base, ["clone", "-q", origin, "clone"]);

  git(clonePath, ["worktree", "add", "-q", userWorktree, SOURCE_BRANCH]);
  git(clonePath, ["worktree", "add", "-q", "-B", AGENT_BRANCH, revvWorktree, sourceTip]);

  return { base, origin, clonePath, userWorktree, revvWorktree, sourceTip };
}

describe("checkoutDetachedAt", () => {
  const sourceBranch = SOURCE_BRANCH;
  const agentBranch = AGENT_BRANCH;

  let base: string;
  let userWorktree: string;
  let revvWorktree: string;
  let sourceTip: string;

  beforeEach(() => {
    ({ base, userWorktree, revvWorktree, sourceTip } = makeFixture("revv-gitops-"));
    // One agent commit on top of the PR head.
    commitFile(revvWorktree, "authn.ts", "export const authn = 2;\n", "agent: tweak authn");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("reproduces the branch-checkout collision it exists to avoid", () => {
    expect(() =>
      git(revvWorktree, ["checkout", "-B", sourceBranch, `refs/remotes/origin/${sourceBranch}`]),
    ).toThrow(/already used by worktree/);
  });

  it("positions HEAD at the source-branch tip while another worktree holds it", async () => {
    await checkoutDetachedAt(revvWorktree, `refs/remotes/origin/${sourceBranch}`);

    expect(await revParse(revvWorktree, "HEAD", 5_000)).toBe(sourceTip);
    // Detached: HEAD names no branch, and the user's worktree is untouched.
    expect(() => git(revvWorktree, ["symbolic-ref", "--short", "HEAD"])).toThrow();
    expect(git(userWorktree, ["rev-parse", "HEAD"])).toBe(sourceTip);
    expect(git(userWorktree, ["symbolic-ref", "--short", "HEAD"])).toBe(sourceBranch);
  });

  it("merges the agent branch onto the detached tip and keeps both commits", async () => {
    // Move the source branch ahead so the merge cannot fast-forward — the
    // case that actually writes a merge commit.
    commitFile(userWorktree, "unrelated.ts", "export const other = 1;\n", "upstream: unrelated");
    git(userWorktree, ["push", "-q", "origin", sourceBranch]);
    git(revvWorktree, ["fetch", "-q", "origin", `+refs/heads/*:refs/remotes/origin/*`]);
    const newSourceTip = git(userWorktree, ["rev-parse", "HEAD"]);

    await checkoutDetachedAt(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
    const result = await merge(
      revvWorktree,
      agentBranch,
      `Merge branch '${agentBranch}' into ${sourceBranch}`,
    );

    expect(result.ok).toBe(true);
    const mergedTip = await revParse(revvWorktree, "HEAD", 5_000);
    expect(git(revvWorktree, ["log", "-1", "--format=%s"])).toBe(
      `Merge branch '${agentBranch}' into ${sourceBranch}`,
    );
    for (const ancestor of [newSourceTip, git(revvWorktree, ["rev-parse", agentBranch])]) {
      expect(() =>
        git(revvWorktree, ["merge-base", "--is-ancestor", ancestor, mergedTip]),
      ).not.toThrow();
    }
  });
});

// ── isMergeInProgress ────────────────────────────────────────────────────────
//
// Every per-PR worktree Revv creates is a *linked* worktree, where `.git` is a
// file (`gitdir: …/.git/worktrees/<name>`) rather than a directory. The old
// `existsSync(<worktree>/.git/MERGE_HEAD)` probe therefore answered "no merge
// in progress" for every conflict, which made `performMerge` treat a conflict
// as a hard failure: no `git merge --abort`, no conflict-resolution flow, and
// a worktree stranded mid-merge that dead-ended every later push on "worktree
// has uncommitted changes".

describe("isMergeInProgress", () => {
  const sourceBranch = SOURCE_BRANCH;
  const agentBranch = AGENT_BRANCH;

  let base: string;
  let userWorktree: string;
  let revvWorktree: string;

  beforeEach(() => {
    ({ base, userWorktree, revvWorktree } = makeFixture("revv-gitops-merge-"));

    // Both sides edit the same line — an unavoidable merge conflict.
    commitFile(revvWorktree, "authn.ts", "export const authn = 2;\n", "agent: authn = 2");
    commitFile(userWorktree, "authn.ts", "export const authn = 3;\n", "upstream: authn = 3");
    git(userWorktree, ["push", "-q", "origin", sourceBranch]);
    git(revvWorktree, ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("is false on a clean linked worktree", async () => {
    expect(await isMergeInProgress(revvWorktree)).toBe(false);
  });

  it("is true after a conflicted merge in a linked worktree", async () => {
    // Guard the premise: `.git` really is a file here, which is what broke the
    // old filesystem probe.
    expect(statSync(join(revvWorktree, ".git")).isFile()).toBe(true);

    await checkoutDetachedAt(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
    const result = await merge(revvWorktree, agentBranch, "merge");

    expect(result.ok).toBe(false);
    expect(await isMergeInProgress(revvWorktree)).toBe(true);
    expect(await unmergedPaths(revvWorktree)).toEqual(["authn.ts"]);
  });

  it("is false again once the merge is aborted", async () => {
    await checkoutDetachedAt(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
    await merge(revvWorktree, agentBranch, "merge");

    expect(await abortMerge(revvWorktree)).toBe(true);
    expect(await isMergeInProgress(revvWorktree)).toBe(false);
    expect((await workingTreeIsClean(revvWorktree)).clean).toBe(true);
  });

  // `unstagedOutsideMerge` is what decides whether the push preflight may
  // `git merge --abort` an abandoned merge. The abort hard-resets the working
  // tree and there is no reflog for unstaged work, so answering "yes" over
  // someone's uncommitted edit destroys it with no way back.
  describe("unstagedOutsideMerge", () => {
    it("finds nothing in a pure conflict state, so the abort is safe", async () => {
      await checkoutDetachedAt(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
      await merge(revvWorktree, agentBranch, "merge");

      // Premise: the tree IS dirty, so an emptiness check here would be
      // vacuous if it were only reading `workingTreeIsClean`.
      expect((await workingTreeIsClean(revvWorktree)).clean).toBe(false);
      expect(await unmergedPaths(revvWorktree)).toEqual(["authn.ts"]);
      expect(await unstagedOutsideMerge(revvWorktree)).toEqual([]);
    });

    it("finds an uncommitted edit the merge did not make, so the abort is refused", async () => {
      await checkoutDetachedAt(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
      await merge(revvWorktree, agentBranch, "merge");

      // A file the merge never touched, edited in the working tree — exactly
      // what an interrupted chat turn leaves behind. `merge --abort` would
      // silently discard it.
      writeFileSync(join(revvWorktree, "README.md"), "seed\nagent notes\n");

      expect(await unmergedPaths(revvWorktree)).toEqual(["authn.ts"]);
      expect(await unstagedOutsideMerge(revvWorktree)).toEqual(["README.md"]);
    });

    it("ignores untracked files, which `merge --abort` leaves alone", async () => {
      await checkoutDetachedAt(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
      await merge(revvWorktree, agentBranch, "merge");
      writeFileSync(join(revvWorktree, "scratch.log"), "build output\n");

      expect(await unstagedOutsideMerge(revvWorktree)).toEqual([]);
    });
  });
});

// ── classifyPushFailure ──────────────────────────────────────────────────────
//
// Only `remote-moved` should reach the user as "the branch was updated
// remotely. Sync the latest changes and try again" — telling them that when
// a pre-receive hook declined the push sends them to do something that
// cannot help. git prints both cases with the word "rejected", which is what
// the previous bare-substring match got wrong.

describe("classifyPushFailure", () => {
  it("treats git's own local refusals as a moved remote", () => {
    expect(
      classifyPushFailure(
        " ! [rejected]        HEAD -> iam/1-authn-service (non-fast-forward)\n" +
          "error: failed to push some refs to 'https://host/o/r.git'",
      ),
    ).toBe("remote-moved");
    expect(classifyPushFailure(" ! [rejected]  HEAD -> feat (stale info)")).toBe("remote-moved");
    expect(classifyPushFailure(" ! [rejected]  HEAD -> feat (fetch first)")).toBe("remote-moved");
  });

  it("treats a server-side decline as rejected, not as a moved remote", () => {
    expect(
      classifyPushFailure(
        "remote: error: GH006: Protected branch update failed\n" +
          " ! [remote rejected] HEAD -> main (protected branch hook declined)",
      ),
    ).toBe("rejected");
    expect(
      classifyPushFailure(" ! [remote rejected] HEAD -> feat (pre-receive hook declined)"),
    ).toBe("rejected");
    expect(classifyPushFailure(" ! [remote rejected] HEAD -> feat (permission denied)")).toBe(
      "rejected",
    );
  });

  it("recognises transport-level auth failures", () => {
    expect(
      classifyPushFailure(
        "fatal: unable to access 'https://host/o/r.git': The requested URL returned error: 403",
      ),
    ).toBe("auth");
    expect(classifyPushFailure("remote: Write access to repository not granted.")).toBe("auth");
    expect(classifyPushFailure("fatal: Authentication failed for 'https://host/o/r.git/'")).toBe(
      "auth",
    );
  });

  it("does not read a bare 403 in hook output as an auth failure", () => {
    expect(
      classifyPushFailure(
        "remote: Commit c0ffee references ticket OPS-403, which is closed\n" +
          " ! [remote rejected] HEAD -> feat (pre-receive hook declined)",
      ),
    ).toBe("rejected");
  });

  it("falls back to rejected for anything unrecognised", () => {
    expect(classifyPushFailure("error: failed to push some refs")).toBe("rejected");
    expect(classifyPushFailure("")).toBe("rejected");
  });
});

// ── redactGitAuth ────────────────────────────────────────────────────────────

describe("redactGitAuth", () => {
  it("strips the token out of the echoed remote URL", () => {
    const redacted = redactGitAuth(
      "fatal: unable to access 'https://x-access-token:ghs_SuPeRsEcReT@ghe.example/o/r.git': 403",
    );
    expect(redacted).not.toContain("ghs_SuPeRsEcReT");
    expect(redacted).toBe(
      "fatal: unable to access 'https://x-access-token:<redacted>@ghe.example/o/r.git': 403",
    );
  });

  it("strips every occurrence", () => {
    expect(redactGitAuth("a https://x-access-token:t1@h/x b https://x-access-token:t2@h/y")).toBe(
      "a https://x-access-token:<redacted>@h/x b https://x-access-token:<redacted>@h/y",
    );
  });
});

// ── resolveProposedBaseSha ───────────────────────────────────────────────────
//
// Regression cover for "40 proposed commits" in a brand-new chat. The chat
// session row's `prHeadSha` is frozen at the head the session started on, but
// `acquirePrWorktree` resets the per-PR worktree to the *current* head whenever
// the agent branch isn't a descendant of it. `staleHead..HEAD` then reports the
// PR's whole rebased history as the agent's proposed commits.

describe("resolveProposedBaseSha", () => {
  const agentBranch = "revv/pr-1";

  let base: string;
  let worktree: string;
  let oldHead: string;
  let newHead: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "revv-basesha-"));
    worktree = join(base, "repo");
    git(base, ["init", "-q", "-b", agentBranch, "repo"]);
    commitFile(worktree, "README.md", "seed\n", "seed");
    oldHead = commitFile(worktree, "a.ts", "export const a = 1;\n", "pr: first commit");
    newHead = commitFile(worktree, "b.ts", "export const b = 1;\n", "pr: second commit");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const resolve = (sessionPrHeadSha: string, prHeadSha: string | null) =>
    resolveProposedBaseSha({ worktreePath: worktree, tip: "HEAD", sessionPrHeadSha, prHeadSha });

  it("prefers the PR's current head once the worktree has been reset onto it", async () => {
    // The state the bug reproduced in: worktree HEAD *is* the new PR head, the
    // session still names the old one. Anything but `newHead` here surfaces the
    // PR's own commits as proposed commits.
    expect(await resolve(oldHead, newHead)).toBe(newHead);
    expect(await proposedCommitCount(worktree, `${newHead}..HEAD`)).toBe("0");
  });

  it("reports nothing proposed when the PR head has moved past the worktree", async () => {
    // The live shape of the bug: the branch sits on a *former* PR head — the
    // session's baseline was rebased away and the PR has since moved on, so
    // neither candidate is an ancestor of the tip. Only the PR's current head
    // gives the honest answer, which is that the agent proposed nothing.
    const rebased = commitFile(worktree, "d.ts", "export const d = 1;\n", "pr: rebased tip");
    git(worktree, ["reset", "-q", "--hard", newHead]);

    expect(await resolve(oldHead, rebased)).toBe(rebased);
    expect(await proposedCommitCount(worktree, `${rebased}..HEAD`)).toBe("0");
  });

  it("keeps the session baseline while agent commits sit on the older head", async () => {
    // The branch carries agent work built on `oldHead`, so it does not contain
    // the PR's new head. Both candidates attribute exactly the agent's commit
    // to the agent, and a tie leaves the historical baseline in place.
    git(worktree, ["reset", "-q", "--hard", oldHead]);
    commitFile(worktree, "a.ts", "export const a = 2;\n", "agent: tweak a");

    expect(await resolve(oldHead, newHead)).toBe(oldHead);
    expect(await proposedCommitCount(worktree, `${oldHead}..HEAD`)).toBe("1");
  });

  it("counts only the agent's commits when both heads are behind the tip", async () => {
    commitFile(worktree, "c.ts", "export const c = 1;\n", "agent: add c");

    expect(await resolve(oldHead, newHead)).toBe(newHead);
    expect(await proposedCommitCount(worktree, `${newHead}..HEAD`)).toBe("1");
  });

  it("falls back to the session baseline when the PR head is unknown or unusable", async () => {
    expect(await resolve(oldHead, null)).toBe(oldHead);
    expect(await resolve(oldHead, "not-a-sha")).toBe(oldHead);
    // A syntactically valid SHA that this repository has never seen.
    expect(await resolve(oldHead, "0".repeat(40))).toBe(oldHead);
  });
});
