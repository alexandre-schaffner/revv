import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorktreeHealthy } from "./RepoClone";

// Real git repos on disk, no mocks: the healthy case must leave every file
// under `.git` untouched.

const GIT_ENV: Record<string, string> = {
  ...process.env,
  GIT_AUTHOR_NAME: "Revv Test",
  GIT_AUTHOR_EMAIL: "revv-test@example.com",
  GIT_COMMITTER_NAME: "Revv Test",
  GIT_COMMITTER_EMAIL: "revv-test@example.com",
  GIT_TERMINAL_PROMPT: "0",
  // The user's and the system's git config (signing, hooks, templates) stay out of the fixture repos.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

// Every case spawns a dozen real git processes (the fixture in beforeEach, then
// the health check); on a loaded machine that alone can pass bun's 5 s default.
const GIT_CASE_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

async function snapshotMtimes(dir: string): Promise<Map<string, number>> {
  const snapshot = new Map<string, number>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(current, entry.name);
      const rel = join(prefix, entry.name);
      snapshot.set(rel, statSync(abs).mtimeMs);
      if (entry.isDirectory()) await walk(abs, rel);
    }
  };
  await walk(dir, "");
  return snapshot;
}

describe("isWorktreeHealthy", () => {
  const prNumber = 42;
  const prDirName = `pr-${prNumber}`;
  const branchName = `revv/pr-${prNumber}`;

  let base: string;
  let clonePath: string;
  let worktreePath: string;
  let headSha: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "revv-worktree-health-"));
    clonePath = join(base, "clone");
    worktreePath = join(base, "worktrees", prDirName);

    mkdirSync(clonePath, { recursive: true });
    mkdirSync(join(base, "worktrees"), { recursive: true });

    git(clonePath, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(clonePath, "README.md"), "hello\n");
    git(clonePath, ["add", "README.md"]);
    git(clonePath, ["commit", "--quiet", "-m", "initial commit"]);
    headSha = git(clonePath, ["rev-parse", "HEAD"]);

    git(clonePath, ["worktree", "add", "-B", branchName, worktreePath, headSha]);
  }, GIT_CASE_TIMEOUT_MS);

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  }, GIT_CASE_TIMEOUT_MS);

  function healthyParams(): Parameters<typeof isWorktreeHealthy>[0] {
    return { clonePath, branchName, worktreePath, prHeadSha: headSha, prNumber };
  }

  it(
    "reports a healthy worktree without touching .git on disk",
    async () => {
      const refsBefore = await snapshotMtimes(join(clonePath, ".git", "refs"));
      const worktreeGitdirBefore = await snapshotMtimes(
        join(clonePath, ".git", "worktrees", prDirName),
      );

      const healthy = await isWorktreeHealthy(healthyParams());

      expect(healthy).toBe(true);
      expect(await snapshotMtimes(join(clonePath, ".git", "refs"))).toEqual(refsBefore);
      expect(await snapshotMtimes(join(clonePath, ".git", "worktrees", prDirName))).toEqual(
        worktreeGitdirBefore,
      );
    },
    GIT_CASE_TIMEOUT_MS,
  );

  it(
    "refuses a worktree with an in-progress merge (MERGE_HEAD present)",
    async () => {
      writeFileSync(join(clonePath, ".git", "worktrees", prDirName, "MERGE_HEAD"), `${headSha}\n`);

      expect(await isWorktreeHealthy(healthyParams())).toBe(false);
    },
    GIT_CASE_TIMEOUT_MS,
  );

  it(
    "refuses a worktree with a stale index.lock",
    async () => {
      writeFileSync(join(clonePath, ".git", "worktrees", prDirName, "index.lock"), "");

      expect(await isWorktreeHealthy(healthyParams())).toBe(false);
    },
    GIT_CASE_TIMEOUT_MS,
  );

  it(
    "accepts a worktree carrying the agent's commits on top of the PR head",
    async () => {
      writeFileSync(join(worktreePath, "agent.txt"), "agent\n");
      git(worktreePath, ["add", "agent.txt"]);
      git(worktreePath, ["commit", "--quiet", "-m", "agent commit"]);

      expect(await isWorktreeHealthy(healthyParams())).toBe(true);
    },
    GIT_CASE_TIMEOUT_MS,
  );

  // A linked repository can itself be a linked worktree of the user's own
  // repository: `<clone>/.git` is then a file and the PR worktree's gitdir
  // lives in the main repository, not under `<clone>/.git/worktrees/`.
  it(
    "sees a merge in progress when the clone is itself a linked worktree",
    async () => {
      const userClone = join(base, "user-linked");
      const prWorktree = join(base, "worktrees", "pr-7");
      git(clonePath, ["worktree", "add", "--quiet", "--detach", userClone, headSha]);
      git(userClone, ["worktree", "add", "--quiet", "-B", "revv/pr-7", prWorktree, headSha]);
      const params = {
        clonePath: userClone,
        branchName: "revv/pr-7",
        worktreePath: prWorktree,
        prHeadSha: headSha,
        prNumber: 7,
      };
      expect(await isWorktreeHealthy(params)).toBe(true);

      const mergeHead = git(prWorktree, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "MERGE_HEAD",
      ]);
      writeFileSync(mergeHead, `${headSha}\n`);
      expect(await isWorktreeHealthy(params)).toBe(false);
    },
    GIT_CASE_TIMEOUT_MS,
  );

  describe("legacy refs/revv/pr-N ref", () => {
    const legacyRef = `refs/revv/pr-${prNumber}`;

    it(
      "refuses an otherwise-healthy worktree while the legacy ref still exists",
      async () => {
        git(clonePath, ["update-ref", legacyRef, headSha]);

        expect(await isWorktreeHealthy(healthyParams())).toBe(false);
      },
      GIT_CASE_TIMEOUT_MS,
    );

    it(
      "reports healthy again once the legacy ref is deleted",
      async () => {
        git(clonePath, ["update-ref", legacyRef, headSha]);
        expect(await isWorktreeHealthy(healthyParams())).toBe(false);

        git(clonePath, ["update-ref", "-d", legacyRef]);

        expect(await isWorktreeHealthy(healthyParams())).toBe(true);
      },
      GIT_CASE_TIMEOUT_MS,
    );

    it(
      "sees the legacy ref even when packed (not just loose)",
      async () => {
        git(clonePath, ["update-ref", legacyRef, headSha]);
        git(clonePath, ["pack-refs", "--all"]);

        expect(await isWorktreeHealthy(healthyParams())).toBe(false);
      },
      GIT_CASE_TIMEOUT_MS,
    );
  });
});
