import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  decideCloneDestination,
  managedCloneRemovalRefusal,
  parseRemoteFullName,
  remoteUrlMatches,
} from "./policy";

describe("parseRemoteFullName", () => {
  it("parses HTTPS and SSH GitHub remotes for the configured host", () => {
    expect(parseRemoteFullName("https://github.com/octo/repo.git", "github.com")).toBe("octo/repo");
    expect(parseRemoteFullName("git@github.com:octo/repo.git", "github.com")).toBe("octo/repo");
    expect(parseRemoteFullName("ssh://git@github.com/octo/repo.git", "github.com")).toBe(
      "octo/repo",
    );
  });

  it("rejects remotes for a different host", () => {
    expect(parseRemoteFullName("git@github.enterprise.test:octo/repo.git", "github.com")).toBe(
      null,
    );
  });
});

describe("remoteUrlMatches", () => {
  it("compares repository identity case-insensitively", () => {
    expect(remoteUrlMatches("https://github.com/Octo/Repo.git", "github.com", "octo/repo")).toBe(
      true,
    );
  });

  it("rejects a checkout of a different repo under the same owner", () => {
    // Guards the link path: `owner/A` must not be linkable to a clone of
    // `owner/B`, which would write `revv/pr-*` branches into the wrong clone.
    expect(remoteUrlMatches("https://github.com/octo/other.git", "github.com", "octo/repo")).toBe(
      false,
    );
    expect(remoteUrlMatches("git@github.com:octo/other.git", "github.com", "octo/repo")).toBe(
      false,
    );
  });

  it("rejects a matching path on a different host", () => {
    expect(
      remoteUrlMatches("https://github.enterprise.test/octo/repo.git", "github.com", "octo/repo"),
    ).toBe(false);
  });
});

describe("decideCloneDestination", () => {
  it("clones into missing or empty destinations", () => {
    expect(decideCloneDestination("missing", false)).toEqual({
      action: "clone",
      removeExisting: false,
    });
    expect(decideCloneDestination("empty", false)).toEqual({
      action: "clone",
      removeExisting: false,
    });
  });

  it("links a matching git repository outside the managed base", () => {
    expect(decideCloneDestination("matching-git-repo", false)).toEqual({ action: "link" });
  });

  it("adopts a matching git repository inside the managed base", () => {
    // A base-internal clone must become managed, not linked — otherwise
    // delete would never reclaim it and it would leak in `~/.revv`.
    expect(decideCloneDestination("matching-git-repo", true)).toEqual({ action: "adopt" });
  });

  it("refuses different git repositories", () => {
    expect(decideCloneDestination("different-git-repo", true).action).toBe("fail");
  });

  it("only removes non-git collisions under the default Revv base", () => {
    expect(decideCloneDestination("non-empty-non-git", true)).toEqual({
      action: "clone",
      removeExisting: true,
    });
    expect(decideCloneDestination("non-empty-non-git", false).action).toBe("fail");
  });
});

describe("managedCloneRemovalRefusal", () => {
  const repo = { githubHost: "github.com", fullName: "octo/repo", cloneStatus: "ready" as const };
  const base = "/srv/revv-clones";

  it("allows a folder under Revv's base", async () => {
    expect(await managedCloneRemovalRefusal(`${base}/octo/repo`, base, repo)).toBeNull();
  });

  it("refuses the base itself, the root, and anything holding the home directory", async () => {
    expect(await managedCloneRemovalRefusal(base, base, repo)).not.toBeNull();
    expect(await managedCloneRemovalRefusal("/", base, repo)).not.toBeNull();
    expect(await managedCloneRemovalRefusal("   ", base, repo)).not.toBeNull();
    expect(await managedCloneRemovalRefusal(homedir(), base, repo)).not.toBeNull();
    expect(await managedCloneRemovalRefusal(dirname(homedir()), base, repo)).not.toBeNull();
  });

  it("outside the base, removes only a clone of the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "revv-removal-"));
    try {
      const clone = join(root, "octo", "repo");
      const other = join(root, "octo", "other");
      for (const [dir, url] of [
        [clone, "https://github.com/octo/repo.git"],
        [other, "https://github.com/octo/other.git"],
      ] as const) {
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init", "-q", dir]);
        execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
      }
      expect(await managedCloneRemovalRefusal(clone, base, repo)).toBeNull();
      expect(await managedCloneRemovalRefusal(other, base, repo)).not.toBeNull();
      expect(await managedCloneRemovalRefusal(join(root, "octo"), base, repo)).not.toBeNull();
      // A clone Revv never finished there may be a folder it refused to clone into.
      expect(
        await managedCloneRemovalRefusal(clone, base, { ...repo, cloneStatus: "error" }),
      ).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
