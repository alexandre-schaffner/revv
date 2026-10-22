import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseConflictStrategy } from "@revv/shared";
import {
  checkTips,
  clearScratch,
  deleteTipRefs,
  fetchTips,
  type OperationInput,
  prepareScratch,
  pushResult,
  type SyncRepo,
  startOperation,
  type Tips,
  verifyResolution,
} from "./git";

const FIXTURE_ENV: Record<string, string> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: FIXTURE_ENV, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function commit(cwd: string, file: string, body: string, message: string): string {
  const path = join(cwd, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

let root: string;
let origin: string;
let dev: string;
let revv: string;
let scratch: string;
let repo: SyncRepo;

/** Move main on origin; `conflicting` rewrites the line `feat` also rewrote. */
function moveMain(opts: { conflicting: boolean; workflow?: boolean }) {
  git(dev, ["checkout", "-q", "main"]);
  if (opts.conflicting) commit(dev, "shared.txt", "main\n", "main edits shared");
  else commit(dev, "trunk.txt", "trunk\n", "trunk moved");
  if (opts.workflow) commit(dev, ".github/workflows/ci.yml", "on: push\n", "ci");
  git(dev, ["push", "-q", "origin", "main"]);
}

async function tipsOf(): Promise<Tips> {
  const fetched = await fetchTips(repo, "refs/heads/feat");
  if (fetched.kind !== "ok") throw new Error(fetched.message);
  return fetched;
}

function opFor(strategy: BaseConflictStrategy, tips: Tips): OperationInput {
  return { strategy, scratchPath: scratch, tips, baseBranch: "main", sourceBranch: "feat" };
}

/** What the agent does: write the combined file, stage it, continue. */
function resolveAsAgent(strategy: BaseConflictStrategy, body = "main\nfeat\n") {
  writeFileSync(join(scratch, "shared.txt"), body);
  git(scratch, ["add", "shared.txt"]);
  if (strategy === "merge") git(scratch, ["-c", "core.editor=true", "merge", "--continue"]);
  else git(scratch, ["rebase", "--continue"]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "revv-base-conflicts-"));
  origin = join(root, "origin.git");
  dev = join(root, "dev");
  revv = join(root, "revv");
  scratch = join(root, "scratch");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: FIXTURE_ENV });

  execFileSync("git", ["init", "-q", "-b", "main", dev], { env: FIXTURE_ENV });
  git(dev, ["remote", "add", "origin", origin]);
  commit(dev, "shared.txt", "base\n", "base");
  git(dev, ["push", "-q", "origin", "HEAD:main"]);
  git(dev, ["checkout", "-q", "-b", "feat"]);
  commit(dev, "shared.txt", "feat\n", "feat edits shared");
  commit(dev, "feat.txt", "feat\n", "feat adds a file");
  git(dev, ["push", "-q", "origin", "feat"]);

  execFileSync("git", ["clone", "-q", "--depth=1", `file://${origin}`, revv], {
    env: FIXTURE_ENV,
  });
  git(revv, ["config", "user.name", "Revv User"]);
  git(revv, ["config", "user.email", "revv@example.com"]);
  git(revv, ["config", "commit.gpgsign", "false"]);
  git(revv, ["config", "core.hooksPath", "/dev/null"]);

  repo = { clonePath: revv, remoteUrl: `file://${origin}`, prNumber: 7, baseBranch: "main" };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checking a PR against its base", () => {
  it("lists the conflicting files from a shallow clone", async () => {
    moveMain({ conflicting: true });
    const check = await checkTips(revv, await tipsOf());
    expect(check).toEqual({
      status: "conflicts",
      files: ["shared.txt"],
      behindBy: 1,
      touchesWorkflows: false,
    });
  });

  it("reports a base that merges cleanly, and workflow changes on it", async () => {
    moveMain({ conflicting: false, workflow: true });
    const check = await checkTips(revv, await tipsOf());
    expect(check).toEqual({ status: "clean", files: [], behindBy: 2, touchesWorkflows: true });
  });

  it("cleans up its refs", async () => {
    await tipsOf();
    await deleteTipRefs(repo);
    expect(git(revv, ["for-each-ref", "refs/revv"])).toBe("");
  });
});

describe("bringing a PR up to date", () => {
  for (const strategy of ["merge", "rebase"] as const) {
    it(`${strategy}: pauses on the conflict, accepts the agent's resolution, pushes it`, async () => {
      moveMain({ conflicting: true });
      const tips = await tipsOf();
      expect(await prepareScratch(revv, scratch, tips.headTip)).toEqual({ kind: "ok" });
      const op = opFor(strategy, tips);
      expect(await startOperation(op)).toEqual({ kind: "conflict", files: ["shared.txt"] });

      resolveAsAgent(strategy);
      const verified = await verifyResolution({ ...op, conflictFiles: ["shared.txt"] });
      if (verified.kind !== "ok") throw new Error(verified.message);

      expect(
        await pushResult(scratch, repo.remoteUrl, "feat", tips.headTip, verified.head),
      ).toEqual({ kind: "pushed" });
      expect(git(origin, ["show", "feat:shared.txt"])).toBe("main\nfeat");
      const log = git(origin, ["log", "--format=%s", "--first-parent", "feat"]).split("\n");
      expect(log[0]).toBe(
        strategy === "merge" ? "Merge branch 'main' into feat" : "feat adds a file",
      );
      await clearScratch(revv, scratch);
      expect(existsSync(scratch)).toBe(false);
    });
  }

  it("refuses a resolution that still carries conflict markers", async () => {
    moveMain({ conflicting: true });
    const tips = await tipsOf();
    await prepareScratch(revv, scratch, tips.headTip);
    const op = opFor("merge", tips);
    await startOperation(op);
    git(scratch, ["add", "shared.txt"]);
    git(scratch, ["-c", "core.editor=true", "merge", "--continue"]);
    const verified = await verifyResolution({ ...op, conflictFiles: ["shared.txt"] });
    expect(verified.kind).toBe("failed");
  });

  it("refuses a merge the agent reset away", async () => {
    moveMain({ conflicting: true });
    const tips = await tipsOf();
    await prepareScratch(revv, scratch, tips.headTip);
    const op = opFor("merge", tips);
    await startOperation(op);
    git(scratch, ["merge", "--abort"]);
    const verified = await verifyResolution({ ...op, conflictFiles: ["shared.txt"] });
    expect(verified).toEqual({
      kind: "failed",
      message: "The result isn't a merge of main into the PR branch",
    });
  });

  it("refuses a rebase still in progress", async () => {
    moveMain({ conflicting: true });
    const tips = await tipsOf();
    await prepareScratch(revv, scratch, tips.headTip);
    const op = opFor("rebase", tips);
    await startOperation(op);
    const verified = await verifyResolution({ ...op, conflictFiles: ["shared.txt"] });
    expect(verified).toEqual({ kind: "failed", message: "The rebase is still in progress" });
  });

  it("loses the lease when the branch moved meanwhile", async () => {
    moveMain({ conflicting: true });
    const tips = await tipsOf();
    await prepareScratch(revv, scratch, tips.headTip);
    const op = opFor("merge", tips);
    await startOperation(op);
    resolveAsAgent("merge");
    const verified = await verifyResolution({ ...op, conflictFiles: ["shared.txt"] });
    if (verified.kind !== "ok") throw new Error(verified.message);

    git(dev, ["checkout", "-q", "feat"]);
    commit(dev, "late.txt", "late\n", "pushed from elsewhere");
    git(dev, ["push", "-q", "origin", "feat"]);

    expect(await pushResult(scratch, repo.remoteUrl, "feat", tips.headTip, verified.head)).toEqual({
      kind: "moved",
    });
  });

  it("clears a scratch worktree a dead run left mid-merge", async () => {
    moveMain({ conflicting: true });
    const tips = await tipsOf();
    await prepareScratch(revv, scratch, tips.headTip);
    await startOperation(opFor("merge", tips));
    expect(await prepareScratch(revv, scratch, tips.headTip)).toEqual({ kind: "ok" });
    expect(git(scratch, ["status", "--porcelain"])).toBe("");
  });
});
