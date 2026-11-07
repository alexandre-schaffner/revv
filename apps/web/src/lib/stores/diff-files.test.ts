import { beforeEach, describe, expect, it, mock } from "bun:test";
import { prsStub } from "$lib/test-stubs";

const PR = "repo:1";
let headSha = "a";
let fail = false;

mock.module("$lib/api/client", () => ({
  api: {
    api: {
      prs: () => ({
        files: {
          get: async () =>
            fail
              ? { data: null, error: { status: 502, value: { error: "down" } } }
              : {
                  data: [{ path: "src/a.ts", patch: "@@", additions: 1, deletions: 0 }],
                  error: null,
                },
        },
      }),
    },
  },
}));
mock.module("$lib/stores/prs.svelte", () =>
  prsStub({ getPrById: (id: string) => (id === PR ? { id, headSha } : undefined) }),
);
mock.module("$lib/stores/pr-view-state.svelte", () => ({
  getActiveFilePath: () => null,
  setActiveFilePath: () => {},
}));

const files = await import("./diff-files.svelte");

beforeEach(() => {
  files.reset();
  headSha = "a";
  fail = false;
});

describe("the head a PR's files were loaded at", () => {
  it("is the PR's head once the files land", async () => {
    await files.loadReviewFiles(PR);
    expect(files.getLoadedHeadSha(PR)).toBe("a");
  });

  it("is forgotten when the page leaves the PR, so a moved head offers no Pull on return", async () => {
    await files.loadReviewFiles(PR);
    files.releaseReviewFiles(PR);
    headSha = "b";
    expect(files.getLoadedHeadSha(PR)).toBeNull();
    await files.loadReviewFiles(PR);
    expect(files.getLoadedHeadSha(PR)).toBe("b");
  });

  it("outlives a failed Pull, so the Pull can be retried", async () => {
    await files.loadReviewFiles(PR);
    headSha = "b";
    fail = true;
    expect(await files.reloadReviewFiles(PR)).toBe(false);
    expect(files.getLoadedHeadSha(PR)).toBe("a");
  });
});
