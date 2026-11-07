import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortMerge,
  checkoutDetached,
  isMergeInProgress,
  merge,
  removeWorktree,
  resolveRef,
  unmergedPaths,
  unstagedOutsideMerge,
  workingTreeIsClean,
} from "./ops";
import { classifyPushFailure, workflowPermissionRejection } from "./push";
import { redactGitAuth } from "./remote";
import { gitAttempt } from "./runner";

// git processes start slowly on a loaded machine; a test here runs a dozen.
setDefaultTimeout(60_000);

const GIT_ENV: Record<string, string> = {
  ...process.env,
  // Neutralise the developer's own `~/.gitconfig`: `commit.gpgsign=true` makes
  // every `commitFile` prompt or fail, and a global `core.hooksPath` runs their
  // hooks inside the fixture repos. CI has neither, so only local runs break.
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

// Slashed, the shape of branch that surfaced the worktree collision.
const SOURCE_BRANCH = "iam/1-authn-service";
const AGENT_BRANCH = "revv/pr-1";

interface Fixture {
  /** Temp root holding every repo below. */
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

function fixtureAt(base: string, sourceTip: string): Fixture {
  return {
    base,
    origin: join(base, "origin"),
    clonePath: join(base, "clone"),
    userWorktree: join(base, "user-worktree"),
    revvWorktree: join(base, "revv-worktree"),
    sourceTip,
  };
}

/**
 * A bare origin, one clone, and **two linked worktrees** of that clone: the
 * user's and Revv's. Being linked makes `.git` a *file* in each, and the user's
 * holding the source branch makes `git checkout -B {sourceBranch}` illegal in
 * Revv's.
 */
function buildFixture(base: string): string {
  const { origin, clonePath, userWorktree, revvWorktree } = fixtureAt(base, "");
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
  // The code under test runs git with the developer's own environment, so
  // their global `commit.gpgsign` would sign every merge it writes here (and
  // prompt, or fail, with the signer locked). The clone's config wins over it
  // and is shared by both linked worktrees.
  git(clonePath, ["config", "commit.gpgsign", "false"]);
  git(clonePath, ["config", "user.name", "Revv Test"]);
  git(clonePath, ["config", "user.email", "revv-test@example.com"]);

  git(clonePath, ["worktree", "add", "-q", userWorktree, SOURCE_BRANCH]);
  git(clonePath, ["worktree", "add", "-q", "-B", AGENT_BRANCH, revvWorktree, sourceTip]);
  return sourceTip;
}

// Built once and copied back before each test: the repos record absolute
// paths, so the copy goes back to the same place.
let fixtureBase: string;
let pristine: string;
let pristineSourceTip: string;

beforeAll(() => {
  fixtureBase = mkdtempSync(join(tmpdir(), "revv-gitops-"));
  pristineSourceTip = buildFixture(fixtureBase);
  pristine = `${fixtureBase}-pristine`;
  cpSync(fixtureBase, pristine, { recursive: true });
});

afterAll(() => {
  rmSync(fixtureBase, { recursive: true, force: true });
  rmSync(pristine, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  rmSync(fixtureBase, { recursive: true, force: true });
  cpSync(pristine, fixtureBase, { recursive: true });
  return fixtureAt(fixtureBase, pristineSourceTip);
}

describe("checkoutDetached", () => {
  const sourceBranch = SOURCE_BRANCH;
  const agentBranch = AGENT_BRANCH;

  let userWorktree: string;
  let revvWorktree: string;
  let sourceTip: string;

  beforeEach(() => {
    ({ userWorktree, revvWorktree, sourceTip } = makeFixture());
    commitFile(revvWorktree, "authn.ts", "export const authn = 2;\n", "agent: tweak authn");
  });

  it("positions HEAD at the source-branch tip while another worktree holds it", async () => {
    await checkoutDetached(revvWorktree, `refs/remotes/origin/${sourceBranch}`);

    expect(await resolveRef(revvWorktree, "HEAD")).toBe(sourceTip);
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

    await checkoutDetached(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
    const result = await merge(revvWorktree, agentBranch, {
      message: `Merge branch '${agentBranch}' into ${sourceBranch}`,
    });

    expect(result.ok).toBe(true);
    const mergedTip = (await resolveRef(revvWorktree, "HEAD")) ?? "";
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

describe("isMergeInProgress", () => {
  const sourceBranch = SOURCE_BRANCH;
  const agentBranch = AGENT_BRANCH;

  let userWorktree: string;
  let revvWorktree: string;

  beforeEach(() => {
    ({ userWorktree, revvWorktree } = makeFixture());

    commitFile(revvWorktree, "authn.ts", "export const authn = 2;\n", "agent: authn = 2");
    commitFile(userWorktree, "authn.ts", "export const authn = 3;\n", "upstream: authn = 3");
    git(userWorktree, ["push", "-q", "origin", sourceBranch]);
    git(revvWorktree, ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  });

  it("is false on a clean linked worktree", async () => {
    expect(await isMergeInProgress(revvWorktree)).toBe(false);
  });

  it("is true after a conflicted merge in a linked worktree", async () => {
    // Premise: in a linked worktree `.git` is a file, not a directory.
    expect(statSync(join(revvWorktree, ".git")).isFile()).toBe(true);

    await checkoutDetached(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
    const result = await merge(revvWorktree, agentBranch, { message: "merge" });

    expect(result.ok).toBe(false);
    expect(await isMergeInProgress(revvWorktree)).toBe(true);
    expect(await unmergedPaths(revvWorktree)).toEqual(["authn.ts"]);
  });

  it("is false again once the merge is aborted", async () => {
    await checkoutDetached(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
    await merge(revvWorktree, agentBranch, { message: "merge" });

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
      await checkoutDetached(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
      await merge(revvWorktree, agentBranch, { message: "merge" });

      // Premise: the tree IS dirty, so an emptiness check here would be
      // vacuous if it were only reading `workingTreeIsClean`.
      expect((await workingTreeIsClean(revvWorktree)).clean).toBe(false);
      expect(await unmergedPaths(revvWorktree)).toEqual(["authn.ts"]);
      expect(await unstagedOutsideMerge(revvWorktree)).toEqual([]);
    });

    it("finds an uncommitted edit the merge did not make, so the abort is refused", async () => {
      await checkoutDetached(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
      await merge(revvWorktree, agentBranch, { message: "merge" });

      // A file the merge never touched, edited in the working tree — exactly
      // what an interrupted chat turn leaves behind. `merge --abort` would
      // silently discard it.
      writeFileSync(join(revvWorktree, "README.md"), "seed\nagent notes\n");

      expect(await unmergedPaths(revvWorktree)).toEqual(["authn.ts"]);
      expect(await unstagedOutsideMerge(revvWorktree)).toEqual(["README.md"]);
    });

    it("ignores untracked files, which `merge --abort` leaves alone", async () => {
      await checkoutDetached(revvWorktree, `refs/remotes/origin/${sourceBranch}`);
      await merge(revvWorktree, agentBranch, { message: "merge" });
      writeFileSync(join(revvWorktree, "scratch.log"), "build output\n");

      expect(await unstagedOutsideMerge(revvWorktree)).toEqual([]);
    });
  });
});

// Only `remote-moved` may reach the user as "the branch was updated remotely.
// Sync the latest changes and try again": told that after a pre-receive hook
// declined the push, they'd do something that cannot help. git prints both
// cases with the word "rejected".

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

// An agent fixing CI is routine, and the push that ships the fix is refused by
// GitHub on both of Revv's auth paths. Echoing git's wording made users retry
// a push that can never succeed, so the rejection is recognised and rewritten.
// It must stay narrow: a protected-branch or pre-receive decline has to keep
// reaching the user as the remote's own text.

describe("workflowPermissionRejection", () => {
  it("recognises the GitHub App refusal and names the workflow file", () => {
    const stderr =
      "To https://nocturlab.ghe.com/Merkl/monorepo.git\n" +
      " ! [remote rejected] HEAD -> iam/backoffice-apps (refusing to allow a GitHub App to " +
      "create or update workflow `.github/workflows/buncodeq.yml` without `workflows` permission)\n" +
      "error: failed to push some refs to 'https://nocturlab.ghe.com/Merkl/monorepo.git'";
    expect(workflowPermissionRejection(stderr)).toEqual({
      path: ".github/workflows/buncodeq.yml",
    });
  });

  it("recognises the OAuth/PAT refusal, worded with `workflow` scope", () => {
    expect(
      workflowPermissionRejection(
        " ! [remote rejected] HEAD -> feat (refusing to allow an OAuth App to create or update " +
          "workflow `.github/workflows/ci.yml` without `workflow` scope)",
      ),
    ).toEqual({ path: ".github/workflows/ci.yml" });
  });

  it("still reports the refusal when GitHub names no file", () => {
    expect(
      workflowPermissionRejection(
        " ! [remote rejected] HEAD -> feat (refusing to allow a GitHub App to create or update " +
          "workflows without `workflows` permission)",
      ),
    ).toEqual({ path: null });
  });

  it("leaves every other rejection alone", () => {
    expect(
      workflowPermissionRejection(
        "remote: error: GH006: Protected branch update failed\n" +
          " ! [remote rejected] HEAD -> main (protected branch hook declined)",
      ),
    ).toBeNull();
    expect(
      workflowPermissionRejection(
        "remote: your commit touches `.github/workflows/ci.yml`; ask #ci first\n" +
          " ! [remote rejected] HEAD -> feat (pre-receive hook declined)",
      ),
    ).toBeNull();
    expect(workflowPermissionRejection("")).toBeNull();
  });
});

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

// Revv's clone is often the user's own repository. Their hooks (a husky
// post-checkout, a pre-push test run) are theirs to trigger and never run. The
// commits Revv writes for their branches are signed the way they sign, but
// nothing may prompt: a signer that would ask fails (or times out) with its
// reason, instead of hanging the push.

/** A stand-in `gpg.program`: `ok` signs, `refuse` fails, `hang` never answers. */
function fakeSigner(dir: string, behaviour: "ok" | "refuse" | "hang"): string {
  const path = join(dir, `gpg-${behaviour}`);
  const body = {
    ok:
      'cat >/dev/null\necho >&2\necho "[GNUPG:] SIG_CREATED D 1 8 00 1700000000 FAKE" >&2\n' +
      'printf -- "-----BEGIN PGP SIGNATURE-----\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n"',
    refuse: 'echo "gpg: signing failed: Inappropriate ioctl for device" >&2\nexit 2',
    hang: "exec sleep 30",
  }[behaviour];
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Sign with `signer` as an OpenPGP program, whatever format the developer's own config picks. */
function signWith(clonePath: string, signer: string): void {
  git(clonePath, ["config", "commit.gpgsign", "true"]);
  git(clonePath, ["config", "gpg.format", "openpgp"]);
  git(clonePath, ["config", "gpg.program", signer]);
}

describe("every git command Revv runs", () => {
  let fixture: Fixture;
  let ran: string;

  const detachOntoSource = async () => {
    const detached = await checkoutDetached(
      fixture.revvWorktree,
      `refs/remotes/origin/${SOURCE_BRANCH}`,
    );
    expect(detached.ok).toBe(true);
  };

  beforeEach(() => {
    fixture = makeFixture();
    commitFile(fixture.revvWorktree, "agent.ts", "agent\n", "agent: add");
    commitFile(fixture.userWorktree, "user.ts", "user\n", "user: add");
    git(fixture.userWorktree, ["push", "-q", "origin", SOURCE_BRANCH]);
    git(fixture.revvWorktree, ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"]);

    const hooks = join(fixture.base, "hooks");
    ran = join(fixture.base, "hook-ran");
    mkdirSync(hooks);
    for (const hook of ["post-checkout", "pre-merge-commit", "commit-msg", "post-merge"]) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${ran}"\nexit 1\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    git(fixture.clonePath, ["config", "core.hooksPath", hooks]);
  });

  it("runs none of the user's hooks", async () => {
    await detachOntoSource();
    const merged = await merge(fixture.revvWorktree, AGENT_BRANCH, { message: "merge" });
    expect(merged.ok).toBe(true);
    expect(git(fixture.revvWorktree, ["log", "-1", "--format=%P"]).split(" ")).toHaveLength(2);
    expect(existsSync(ran)).toBe(false);
  });

  it("signs the commits it writes for the user's branch the way the user signs", async () => {
    signWith(fixture.clonePath, fakeSigner(fixture.base, "ok"));
    await detachOntoSource();

    const merged = await merge(fixture.revvWorktree, AGENT_BRANCH, { message: "merge" });
    expect(merged.ok).toBe(true);
    expect(git(fixture.revvWorktree, ["cat-file", "commit", "HEAD"])).toContain("gpgsig ");
    expect(existsSync(ran)).toBe(false);
  });

  it("surfaces a signer that refuses with its reason, not as a timeout", async () => {
    signWith(fixture.clonePath, fakeSigner(fixture.base, "refuse"));
    await detachOntoSource();

    const merged = await merge(fixture.revvWorktree, AGENT_BRANCH, { message: "merge" });
    expect(merged.ok).toBe(false);
    expect(merged.timedOut).toBe(false);
    expect(merged.stderr).toMatch(/sign/i);
  });

  it("gives up on a signer that never answers instead of hanging", async () => {
    signWith(fixture.clonePath, fakeSigner(fixture.base, "hang"));

    const attempt = await gitAttempt(
      fixture.revvWorktree,
      ["commit", "--allow-empty", "-m", "signed"],
      1_500,
      { signing: "user" },
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.timedOut).toBe(true);
  });

  it("writes internal commits unsigned whatever the user's config says", async () => {
    signWith(fixture.clonePath, fakeSigner(fixture.base, "refuse"));

    const attempt = await gitAttempt(
      fixture.revvWorktree,
      ["commit", "--allow-empty", "-m", "internal"],
      10_000,
    );
    expect(attempt.ok).toBe(true);
  });
});

describe("removeWorktree", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  // `git worktree prune` would also drop the user's worktrees whose drive
  // isn't mounted: Revv only ever removes the worktree it names.
  it("drops the named worktree, even with its folder gone, and nothing else", async () => {
    rmSync(fixture.userWorktree, { recursive: true, force: true });
    rmSync(fixture.revvWorktree, { recursive: true, force: true });

    expect(await removeWorktree(fixture.clonePath, fixture.revvWorktree)).toBe(true);

    const listed = git(fixture.clonePath, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain(fixture.userWorktree);
    expect(listed).not.toContain(fixture.revvWorktree);
  });
});
