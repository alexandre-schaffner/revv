import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitsStrandedBy,
  countProposed,
  dropProposedCommits,
  healAbandonedMerge,
  listProposedCommits,
  replayAgentCommits,
  resetToBase,
  resolveBaseSha,
} from "./agent-branch";
import { type AgentBranch, isWorktreeHealthy } from "./agent-worktrees";

// git processes start slowly on a loaded machine; a test here runs a dozen.
setDefaultTimeout(60_000);

const GIT_ENV: Record<string, string> = {
  ...process.env,
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
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const subjects = (cwd: string, range: string) =>
  git(cwd, ["log", "--format=%s", range]).split("\n").filter(Boolean);

const base = mkdtempSync(join(tmpdir(), "revv-agent-branch-"));
const pristine = `${base}-pristine`;
const worktree = join(base, "repo");
const branch: AgentBranch = { worktreePath: worktree, branchName: "revv/pr-1" };
let oldHead: string;
let prHead: string;

// Built once and copied back before each test: the repo records absolute
// paths, so the copy goes back to the same place.
beforeAll(() => {
  git(base, ["init", "-q", "-b", "revv/pr-1", "repo"]);
  // The rewrites under test run git with the developer's own environment, so
  // their global `commit.gpgsign` would sign (or prompt for) every replayed
  // commit. The repo's config wins over it.
  git(worktree, ["config", "commit.gpgsign", "false"]);
  git(worktree, ["config", "user.name", "Revv Test"]);
  git(worktree, ["config", "user.email", "revv-test@example.com"]);
  commitFile(worktree, "README.md", "seed\n", "seed");
  oldHead = commitFile(worktree, "a.ts", "a1\n", "pr: first commit");
  prHead = commitFile(worktree, "b.ts", "b1\n", "pr: second commit");
  cpSync(base, pristine, { recursive: true });
});

beforeEach(() => {
  rmSync(base, { recursive: true, force: true });
  cpSync(pristine, base, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(pristine, { recursive: true, force: true });
});

// The agent branch's baseline: the tightest of the PR heads Revv has seen.
// A session's `prHeadSha` is frozen when the session starts, but the worktree
// is reset onto the PR's current head when the agent branch isn't built on it;
// measuring from the stale head would report the PR's whole rebased history as
// "proposed commits" in a brand-new chat.
describe("resolveBaseSha", () => {
  it("prefers the PR's current head once the worktree was reset onto it", async () => {
    expect(await resolveBaseSha(branch, [oldHead, prHead])).toBe(prHead);
    expect(await countProposed(branch, prHead)).toBe(0);
  });

  it("reports nothing proposed when the PR head moved past the worktree", async () => {
    const rebased = commitFile(worktree, "d.ts", "d\n", "pr: rebased tip");
    git(worktree, ["reset", "-q", "--hard", prHead]);
    expect(await resolveBaseSha(branch, [oldHead, rebased])).toBe(rebased);
    expect(await countProposed(branch, rebased)).toBe(0);
  });

  it("keeps the earlier candidate on a tie, while agent commits sit on the older head", async () => {
    git(worktree, ["reset", "-q", "--hard", oldHead]);
    commitFile(worktree, "a.ts", "a2\n", "agent: tweak a");
    expect(await resolveBaseSha(branch, [oldHead, prHead])).toBe(oldHead);
    expect(await countProposed(branch, oldHead)).toBe(1);
  });

  it("counts only the agent's commits when every head is behind the tip", async () => {
    commitFile(worktree, "c.ts", "c\n", "agent: add c");
    expect(await resolveBaseSha(branch, [oldHead, prHead])).toBe(prHead);
    expect(await countProposed(branch, prHead)).toBe(1);
  });

  it("skips candidates that are malformed or unknown here", async () => {
    expect(await resolveBaseSha(branch, [oldHead, "not-a-sha", "0".repeat(40)])).toBe(oldHead);
    expect(await resolveBaseSha(branch, [])).toBeNull();
  });

  it("measures the branch, not HEAD, which a killed push leaves detached elsewhere", async () => {
    commitFile(worktree, "c.ts", "c\n", "agent: add c");
    git(worktree, ["checkout", "-q", "--detach", oldHead]);
    expect(await resolveBaseSha(branch, [oldHead, prHead])).toBe(prHead);
    expect(await countProposed(branch, prHead)).toBe(1);
  });
});

describe("listProposedCommits", () => {
  it("lists the agent's commits newest first, each with the paths it touched", async () => {
    const one = commitFile(worktree, "c.ts", "c\n", "agent: add c");
    writeFileSync(join(worktree, "d.ts"), "d\n");
    writeFileSync(join(worktree, "c.ts"), "c2\n");
    git(worktree, ["add", "c.ts", "d.ts"]);
    git(worktree, ["commit", "-q", "-m", "agent: add d"]);
    const two = git(worktree, ["rev-parse", "HEAD"]);

    const listed = await listProposedCommits(branch, prHead);

    expect(listed.map((c) => [c.sha, c.shortSha, c.files])).toEqual([
      [two, two.slice(0, 7), ["c.ts", "d.ts"]],
      [one, one.slice(0, 7), ["c.ts"]],
    ]);
    expect(listed[1]?.subject).toBe("agent: add c");
  });

  it("is empty when the agent hasn't committed", async () => {
    expect(await listProposedCommits(branch, prHead)).toEqual([]);
  });
});

describe("dropProposedCommits", () => {
  let one: string;
  let two: string;
  let three: string;

  beforeEach(() => {
    one = commitFile(worktree, "one.ts", "1\n", "agent: one");
    two = commitFile(worktree, "two.ts", "2\n", "agent: two");
    three = commitFile(worktree, "three.ts", "3\n", "agent: three");
  });

  it("rebuilds the branch without the dropped commits", async () => {
    const result = await dropProposedCommits(branch, prHead, new Set([two]));
    expect(result).toEqual({ kind: "dropped", count: 1 });
    expect(subjects(worktree, `${prHead}..revv/pr-1`)).toEqual(["agent: three", "agent: one"]);
    expect(git(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("revv/pr-1");
  });

  it("rewrites the branch even when HEAD is detached somewhere else", async () => {
    git(worktree, ["checkout", "-q", "--detach", oldHead]);
    const result = await dropProposedCommits(branch, prHead, new Set([one]));
    expect(result).toEqual({ kind: "dropped", count: 1 });
    expect(subjects(worktree, `${prHead}..revv/pr-1`)).toEqual(["agent: three", "agent: two"]);
  });

  it("ignores commits that aren't proposed", async () => {
    expect(await dropProposedCommits(branch, prHead, new Set([oldHead]))).toEqual({
      kind: "none-matched",
    });
    expect(git(worktree, ["rev-parse", "revv/pr-1"])).toBe(three);
  });

  it("puts the branch back when a kept commit no longer applies", async () => {
    const touchesOne = commitFile(worktree, "one.ts", "1 then 4\n", "agent: four edits one");
    const result = await dropProposedCommits(branch, prHead, new Set([one]));
    expect(result.kind).toBe("conflict");
    expect(git(worktree, ["rev-parse", "revv/pr-1"])).toBe(touchesOne);
    expect(git(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("revv/pr-1");
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
  });
});

describe("replayAgentCommits", () => {
  it("rebuilds the branch on a pushed tip, skipping what the tip already has", async () => {
    const picked = commitFile(worktree, "picked.ts", "p\n", "agent: picked");
    commitFile(worktree, "kept.ts", "k\n", "agent: kept");
    const oldTip = git(worktree, ["rev-parse", "HEAD"]);
    // What the cherry-pick push leaves: the picked commit on the source tip.
    git(worktree, ["checkout", "-q", "--detach", prHead]);
    git(worktree, ["cherry-pick", picked]);
    const pushedTip = git(worktree, ["rev-parse", "HEAD"]);

    expect(await replayAgentCommits(branch, { onto: pushedTip, upstream: prHead, oldTip })).toEqual(
      {
        ok: true,
      },
    );
    expect(subjects(worktree, `${pushedTip}..revv/pr-1`)).toEqual(["agent: kept"]);
    expect(git(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("revv/pr-1");
  });
});

describe("resetToBase", () => {
  it("rewinds the branch from a detached HEAD and drops untracked files", async () => {
    commitFile(worktree, "c.ts", "c\n", "agent: add c");
    git(worktree, ["checkout", "-q", "--detach", oldHead]);
    writeFileSync(join(worktree, "stray.txt"), "left by the agent\n");

    expect(await resetToBase(branch, prHead)).toBeNull();

    expect(git(worktree, ["rev-parse", "revv/pr-1"])).toBe(prHead);
    expect(git(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("revv/pr-1");
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
  });

  it("says why when the rewind can't land, so the clear fails instead of reporting success", async () => {
    const tip = commitFile(worktree, "c.ts", "c\n", "agent: add c");

    const failed = await resetToBase(branch, "0".repeat(40));

    expect(failed).toContain("reset --hard failed");
    expect(git(worktree, ["rev-parse", "revv/pr-1"])).toBe(tip);
  });
});

describe("healAbandonedMerge", () => {
  beforeEach(() => {
    git(worktree, ["checkout", "-q", "-b", "source", oldHead]);
    commitFile(worktree, "b.ts", "source b\n", "source: b");
    commitFile(worktree, "README.md", "seed\nsource\n", "source: readme");
    git(worktree, ["checkout", "-q", "revv/pr-1"]);
    commitFile(worktree, "b.ts", "agent b\n", "agent: b");
    git(worktree, ["checkout", "-q", "--detach", "source"]);
    expect(() => git(worktree, ["merge", "--no-edit", "revv/pr-1"])).toThrow();
  });

  it("aborts a conflicted merge nobody holds and returns to the agent branch", async () => {
    expect(await healAbandonedMerge(branch)).toBe(true);
    expect(git(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("revv/pr-1");
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
  });

  it("refuses when an edit outside the conflict would be lost", async () => {
    writeFileSync(join(worktree, "a.ts"), "uncommitted agent edit\n");
    expect(await healAbandonedMerge(branch)).toBe(false);
    expect(git(worktree, ["status", "--porcelain"])).toContain("a.ts");
  });
});

// The PR head moved under the agent's unpushed commits. Moving the worktree to
// the new head would reset them away, so the next turn is refused with the
// commits instead; rebasing them (or discarding them) and advancing is the way
// out, and nothing is lost on the way.
describe("commitsStrandedBy", () => {
  let agentCommit: string;
  let newHead: string;

  beforeEach(() => {
    agentCommit = commitFile(worktree, "agent.ts", "agent\n", "agent: add");
    // Someone pushes to the PR: its new head is built on the old one.
    git(worktree, ["branch", "pr-source", prHead]);
    git(worktree, ["checkout", "-q", "pr-source"]);
    newHead = commitFile(worktree, "upstream.ts", "upstream\n", "pr: pushed elsewhere");
    git(worktree, ["checkout", "-q", "revv/pr-1"]);
  });

  const turnAllowed = async () =>
    (await commitsStrandedBy(branch, newHead, [prHead])) === null &&
    (await isWorktreeHealthy({
      clonePath: worktree,
      branchName: "revv/pr-1",
      worktreePath: worktree,
      prHeadSha: newHead,
      prNumber: 1,
    }));

  it("blocks the move, naming the old head and the commits it would lose", async () => {
    expect(await commitsStrandedBy(branch, newHead, [prHead])).toEqual({
      oldHeadSha: prHead,
      commits: [expect.objectContaining({ sha: agentCommit, subject: "agent: add" })],
    });
  });

  it("is resolved by rebasing the commits onto the new head, losing none", async () => {
    const oldTip = git(worktree, ["rev-parse", "revv/pr-1"]);
    expect(await replayAgentCommits(branch, { onto: newHead, upstream: prHead, oldTip })).toEqual({
      ok: true,
    });

    expect(await turnAllowed()).toBe(true);
    expect(subjects(worktree, `${newHead}..revv/pr-1`)).toEqual(["agent: add"]);
    expect(git(worktree, ["show", "revv/pr-1:agent.ts"])).toBe("agent");
  });

  it("is resolved by discarding the commits", async () => {
    expect(await dropProposedCommits(branch, prHead, new Set([agentCommit]))).toEqual({
      kind: "dropped",
      count: 1,
    });
    expect(await commitsStrandedBy(branch, newHead, [prHead])).toBeNull();
  });

  it("lets a move through when the branch carries no agent commits", async () => {
    git(worktree, ["reset", "-q", "--hard", prHead]);
    expect(await commitsStrandedBy(branch, newHead, [prHead])).toBeNull();
  });

  it("lets a move through when the branch is already built on the new head", async () => {
    git(worktree, ["reset", "-q", "--hard", newHead]);
    commitFile(worktree, "agent.ts", "agent\n", "agent: add");
    expect(await commitsStrandedBy(branch, newHead, [prHead, newHead])).toBeNull();
  });
});

describe("rewrites that a signer refuses", () => {
  it("report a failure, not a conflict, and leave the branch as it was", async () => {
    const one = commitFile(worktree, "one.ts", "1\n", "agent: one");
    commitFile(worktree, "two.ts", "2\n", "agent: two");
    const tip = git(worktree, ["rev-parse", "HEAD"]);
    const signer = join(base, "gpg-refuse");
    writeFileSync(signer, '#!/bin/sh\necho "gpg: signing failed: No pinentry" >&2\nexit 2\n');
    chmodSync(signer, 0o755);
    git(worktree, ["config", "commit.gpgsign", "true"]);
    git(worktree, ["config", "gpg.format", "openpgp"]);
    git(worktree, ["config", "gpg.program", signer]);

    const dropped = await dropProposedCommits(branch, prHead, new Set([one]));
    expect(dropped.kind).toBe("failed");
    expect(dropped.kind === "failed" && dropped.message).toMatch(/sign/i);
    expect(git(worktree, ["rev-parse", "revv/pr-1"])).toBe(tip);
  });
});
