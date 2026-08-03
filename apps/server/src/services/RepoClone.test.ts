import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorktreeHealthy } from "./RepoClone";

// ── isWorktreeHealthy ────────────────────────────────────────────────────────
//
// `isWorktreeHealthy` is the read-only gate `acquirePrWorktree` consults
// before falling through to its cold path (lock cleanup, ref deletion,
// merge/rebase abort — all writes under `.git`). These tests build a real
// git repo + worktree on disk (no mocks — the whole point is verifying
// nothing on disk changes) and assert both the boolean result and, for the
// healthy case, that not a single file under `.git` was touched.

const GIT_ENV: Record<string, string> = {
  ...process.env,
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

/** Recursively snapshots mtimes of every entry under `dir`, keyed by path relative to `dir`. */
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
    // The user's global config may force commit signing (`commit.gpgsign`),
    // which hangs/fails in a sandboxed test env with no signing agent.
    // Scope the override to this throwaway repo only.
    git(clonePath, ["config", "commit.gpgsign", "false"]);
    git(clonePath, ["config", "tag.gpgsign", "false"]);
    writeFileSync(join(clonePath, "README.md"), "hello\n");
    git(clonePath, ["add", "README.md"]);
    git(clonePath, ["commit", "--quiet", "-m", "initial commit"]);
    headSha = git(clonePath, ["rev-parse", "HEAD"]);

    git(clonePath, ["worktree", "add", "-B", branchName, worktreePath, headSha]);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("reports a healthy worktree without touching .git on disk", async () => {
    const refsBefore = await snapshotMtimes(join(clonePath, ".git", "refs"));
    const worktreeGitdirBefore = await snapshotMtimes(
      join(clonePath, ".git", "worktrees", prDirName),
    );

    const healthy = await isWorktreeHealthy({
      clonePath,
      prDirName,
      branchName,
      worktreePath,
      prHeadSha: headSha,
      exactHead: true,
    });

    expect(healthy).toBe(true);
    expect(await snapshotMtimes(join(clonePath, ".git", "refs"))).toEqual(refsBefore);
    expect(await snapshotMtimes(join(clonePath, ".git", "worktrees", prDirName))).toEqual(
      worktreeGitdirBefore,
    );
  });

  it("refuses a worktree with an in-progress merge (MERGE_HEAD present)", async () => {
    writeFileSync(join(clonePath, ".git", "worktrees", prDirName, "MERGE_HEAD"), `${headSha}\n`);

    const healthy = await isWorktreeHealthy({
      clonePath,
      prDirName,
      branchName,
      worktreePath,
      prHeadSha: headSha,
      exactHead: true,
    });

    expect(healthy).toBe(false);
  });

  it("refuses a worktree with a stale index.lock", async () => {
    writeFileSync(join(clonePath, ".git", "worktrees", prDirName, "index.lock"), "");

    const healthy = await isWorktreeHealthy({
      clonePath,
      prDirName,
      branchName,
      worktreePath,
      prHeadSha: headSha,
      exactHead: true,
    });

    expect(healthy).toBe(false);
  });
});
