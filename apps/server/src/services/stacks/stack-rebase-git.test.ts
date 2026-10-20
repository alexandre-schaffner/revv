import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RebaseStep } from "./rebase-plan";
import { cleanupReplay, pushStack, type ReplayInput, replayStack } from "./stack-rebase-git";

// A real "origin", a developer checkout that builds the stack, and Revv's
// shallow clone that rebases it. The code under test inherits the
// developer's ~/.gitconfig, so Revv's clone pins what would otherwise vary
// (identity, signing, hooks) in its own local config.

const FIXTURE_ENV: Record<string, string> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: FIXTURE_ENV, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function commit(cwd: string, file: string, body: string, message: string): string {
  writeFileSync(join(cwd, file), body);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

let root: string;
let origin: string;
let dev: string;
let revv: string;

/** The stack as the plan would hand it over: #1 on main, #2 on #1, #3 on #2. */
let tips: { a: string; b: string; c: string };

function stepsFor(over: { mergedBottom?: boolean } = {}): RebaseStep[] {
  const two: RebaseStep = {
    number: 2,
    headRef: "feat-2",
    tip: tips.b,
    onto: over.mergedBottom ? { kind: "base" } : { kind: "layer", number: 1 },
    upstreams: [tips.a],
  };
  const three: RebaseStep = {
    number: 3,
    headRef: "feat-3",
    tip: tips.c,
    onto: { kind: "layer", number: 2 },
    upstreams: [tips.b],
  };
  if (over.mergedBottom) return [two, three];
  return [
    { number: 1, headRef: "feat-1", tip: tips.a, onto: { kind: "base" }, upstreams: [] },
    two,
    three,
  ];
}

function inputFor(steps: RebaseStep[]): ReplayInput {
  return {
    clonePath: revv,
    scratchPath: join(root, "scratch"),
    remoteUrl: `file://${origin}`,
    baseRefName: "main",
    stackNumber: 9,
    steps,
  };
}

/** What a branch on origin holds: its file contents and its commit subjects, newest first. */
function onOrigin(branch: string) {
  const log = git(origin, ["log", "--format=%s", branch]).split("\n");
  const show = (file: string) => {
    try {
      return git(origin, ["show", `${branch}:${file}`]);
    } catch {
      return null;
    }
  };
  return { log, show };
}

async function rebaseAndPush(steps: RebaseStep[]) {
  const input = inputFor(steps);
  try {
    const replay = await replayStack(input);
    if (replay.kind !== "replayed") return { replay, push: null };
    const moved = steps.flatMap((s) => {
      const to = replay.heads.get(s.number);
      return to && to !== s.tip ? [{ headRef: s.headRef, from: s.tip, to }] : [];
    });
    return { replay, push: await pushStack(revv, input.remoteUrl, moved) };
  } finally {
    await cleanupReplay(input);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "revv-stack-rebase-"));
  origin = join(root, "origin.git");
  dev = join(root, "dev");
  revv = join(root, "revv");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: FIXTURE_ENV });
  git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);

  execFileSync("git", ["init", "-q", "-b", "main", dev], { env: FIXTURE_ENV });
  git(dev, ["remote", "add", "origin", origin]);
  commit(dev, "base.txt", "base\n", "base");
  git(dev, ["push", "-q", "origin", "HEAD:main"]);
  git(dev, ["checkout", "-q", "-b", "feat-1"]);
  const a = commit(dev, "one.txt", "one\n", "one");
  git(dev, ["checkout", "-q", "-b", "feat-2"]);
  const b = commit(dev, "two.txt", "two\n", "two");
  git(dev, ["checkout", "-q", "-b", "feat-3"]);
  const c = commit(dev, "three.txt", "three\n", "three");
  git(dev, ["push", "-q", "origin", "feat-1", "feat-2", "feat-3"]);
  tips = { a, b, c };

  // Revv's clone is shallow, as RepoClone makes it.
  execFileSync("git", ["clone", "-q", "--depth=1", `file://${origin}`, revv], {
    env: FIXTURE_ENV,
  });
  git(revv, ["config", "user.name", "Revv User"]);
  git(revv, ["config", "user.email", "revv@example.com"]);
  git(revv, ["config", "commit.gpgsign", "false"]);
  git(revv, ["config", "core.hooksPath", "/dev/null"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("stack rebase in Revv's clone", () => {
  it("rebases every layer onto the moved base and pushes them together", async () => {
    git(dev, ["checkout", "-q", "main"]);
    commit(dev, "trunk.txt", "trunk\n", "trunk moved");
    git(dev, ["push", "-q", "origin", "main"]);

    const { replay, push } = await rebaseAndPush(stepsFor());
    expect(replay.kind).toBe("replayed");
    expect(push).toEqual({ kind: "pushed" });

    expect(onOrigin("feat-1").log).toEqual(["one", "trunk moved", "base"]);
    expect(onOrigin("feat-2").log).toEqual(["two", "one", "trunk moved", "base"]);
    expect(onOrigin("feat-3").log).toEqual(["three", "two", "one", "trunk moved", "base"]);
    expect(onOrigin("feat-3").show("trunk.txt")).toBe("trunk");
    // Nothing left behind in the clone.
    expect(existsSync(join(root, "scratch"))).toBe(false);
  });

  it("leaves a stack already sitting on its base alone", async () => {
    const { replay, push } = await rebaseAndPush(stepsFor());
    expect(replay.kind).toBe("replayed");
    if (replay.kind === "replayed") {
      expect([...replay.heads.values()]).toEqual([tips.a, tips.b, tips.c]);
    }
    expect(push).toEqual({ kind: "pushed" });
    expect(git(origin, ["rev-parse", "feat-3"])).toBe(tips.c);
  });

  it("keeps a squash-merged layer's commits out of the layers above", async () => {
    // #1 squash-merged: its change lands on main as a different commit.
    git(dev, ["checkout", "-q", "main"]);
    commit(dev, "one.txt", "one\n", "squashed #1");
    git(dev, ["push", "-q", "origin", "main"]);

    const { replay, push } = await rebaseAndPush(stepsFor({ mergedBottom: true }));
    expect(replay.kind).toBe("replayed");
    expect(push).toEqual({ kind: "pushed" });
    expect(onOrigin("feat-2").log).toEqual(["two", "squashed #1", "base"]);
    expect(onOrigin("feat-3").log).toEqual(["three", "two", "squashed #1", "base"]);
  });

  it("reports a conflict with its files and pushes nothing", async () => {
    git(dev, ["checkout", "-q", "main"]);
    commit(dev, "one.txt", "someone else's one\n", "conflicting trunk");
    git(dev, ["push", "-q", "origin", "main"]);

    const { replay, push } = await rebaseAndPush(stepsFor());
    expect(replay).toEqual({ kind: "conflict", number: 1, ontoLabel: "main", files: ["one.txt"] });
    expect(push).toBeNull();
    expect(git(origin, ["rev-parse", "feat-1"])).toBe(tips.a);
  });

  it("refuses the whole push when one layer moved meanwhile", async () => {
    git(dev, ["checkout", "-q", "main"]);
    commit(dev, "trunk.txt", "trunk\n", "trunk moved");
    git(dev, ["push", "-q", "origin", "main"]);

    const input = inputFor(stepsFor());
    try {
      const replay = await replayStack(input);
      expect(replay.kind).toBe("replayed");
      if (replay.kind !== "replayed") return;

      // The author pushes to #2 while Revv is about to push.
      git(dev, ["checkout", "-q", "feat-2"]);
      commit(dev, "two.txt", "two, amended\n", "two again");
      git(dev, ["push", "-q", "origin", "feat-2"]);

      const moved = input.steps.map((s) => ({
        headRef: s.headRef,
        from: s.tip,
        to: replay.heads.get(s.number) ?? s.tip,
      }));
      const push = await pushStack(revv, input.remoteUrl, moved);
      expect(push.kind).toBe("moved");
      // Atomic: #1 and #3 didn't move either.
      expect(git(origin, ["rev-parse", "feat-1"])).toBe(tips.a);
      expect(git(origin, ["rev-parse", "feat-3"])).toBe(tips.c);
      expect(readFileSync(join(dev, "two.txt"), "utf8")).toBe("two, amended\n");
    } finally {
      await cleanupReplay(input);
    }
  });
});
