import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceCommit } from "./build-info";

const scratch = mkdtempSync(join(tmpdir(), "revv-build-info-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Fixed identity and dates make the commit's SHA known in advance.
const pinnedCommitEnv = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Revv",
  GIT_AUTHOR_EMAIL: "revv@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Revv",
  GIT_COMMITTER_EMAIL: "revv@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: pinnedCommitEnv, stderr: "pipe" });
  if (!result.success) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

describe("readSourceCommit", () => {
  it("reads the full SHA of the commit a checkout has out", () => {
    const checkout = join(scratch, "checkout");
    git(scratch, "init", "-q", "--object-format=sha1", checkout);
    git(checkout, "commit", "-q", "--allow-empty", "-m", "build");

    expect(readSourceCommit(checkout)).toBe("4d60eccca51ec86e112e56d9f2c8e934fc681ce8");
  });

  it("returns null outside a git checkout", () => {
    const plain = mkdtempSync(join(scratch, "plain-"));
    expect(readSourceCommit(plain)).toBeNull();
  });
});
