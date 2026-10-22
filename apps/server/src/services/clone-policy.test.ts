import { describe, expect, it } from "bun:test";
import {
  assertSafeManagedClonePath,
  CLONE_BASE_DIR,
  decideCloneDestination,
  parseRemoteFullName,
  remoteUrlMatches,
} from "./clone-policy";

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

describe("assertSafeManagedClonePath", () => {
  it("accepts paths under the managed clone base", () => {
    expect(() => assertSafeManagedClonePath(`${CLONE_BASE_DIR}/owner/repo`)).not.toThrow();
  });

  it("rejects paths outside the managed clone base", () => {
    expect(() => assertSafeManagedClonePath("/tmp/owner/repo")).toThrow();
    expect(() => assertSafeManagedClonePath("/etc/passwd")).toThrow();
    expect(() => assertSafeManagedClonePath("/usr/local/src")).toThrow();
  });

  it("rejects empty, root, and home paths", () => {
    expect(() => assertSafeManagedClonePath("")).toThrow();
    expect(() => assertSafeManagedClonePath("   ")).toThrow();
    expect(() => assertSafeManagedClonePath("/")).toThrow();
  });
});
