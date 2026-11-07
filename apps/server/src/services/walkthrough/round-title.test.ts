import { describe, expect, it } from "bun:test";
import type { StoredPrCommit } from "./content";
import { commitsInRoundRange, deriveRoundFocusTitle } from "./round-title";

function commit(sha: string, message: string): StoredPrCommit {
  return { sha, message, authorLogin: null, authorAvatarUrl: null, date: null };
}

describe("commitsInRoundRange", () => {
  const commits = [
    commit("a", "feat: initial"),
    commit("b", "fix: reviewed base"),
    commit("c", "feat: add indexes"),
    commit("d", "test: coverage"),
    commit("e", "fix: tune range query"),
  ];

  it("returns commits after fromSha through toSha for a normal forward range", () => {
    expect(commitsInRoundRange(commits, "b", "d").map((c) => c.sha)).toEqual(["c", "d"]);
  });

  it("returns an empty range when fromSha equals toSha", () => {
    expect(commitsInRoundRange(commits, "c", "c")).toEqual([]);
  });

  it("returns commits after fromSha when toSha is missing from the snapshot", () => {
    expect(commitsInRoundRange(commits, "b", "missing").map((c) => c.sha)).toEqual(["c", "d", "e"]);
  });

  it("returns all commits when neither boundary is available", () => {
    expect(commitsInRoundRange(commits, "missing-base", "missing-head").map((c) => c.sha)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});

describe("deriveRoundFocusTitle", () => {
  it("returns null when persisted commits are unavailable", () => {
    expect(deriveRoundFocusTitle(null, "b", "d")).toBeNull();
  });

  it("uses the newest non-low-signal commit in the selected round", () => {
    const commits = [
      commit("a", "feat: base"),
      commit("b", "fix: previous review"),
      commit("c", "feat(db): add range indexes"),
      commit("d", "test: add query coverage"),
    ];

    // Stored newest first, as `github.prs.commits` returns them.
    expect(deriveRoundFocusTitle(JSON.stringify(commits.toReversed()), "b", "d")).toBe(
      "add range indexes",
    );
  });
});
