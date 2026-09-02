import { describe, expect, it } from "bun:test";
import { reviewNewCommits } from "./review-new-commits";

describe("reviewNewCommits", () => {
  it("waits for the fresh diff before starting the incremental review", async () => {
    const calls: string[] = [];

    await reviewNewCommits({
      pull: async () => {
        calls.push("pull");
        return true;
      },
      regenerate: async () => {
        calls.push("regenerate");
      },
    });

    expect(calls).toEqual(["pull", "regenerate"]);
  });

  it("does not regenerate when refreshing the diff fails", async () => {
    let regenerated = false;

    await reviewNewCommits({
      pull: async () => false,
      regenerate: async () => {
        regenerated = true;
      },
    });

    expect(regenerated).toBe(false);
  });
});
