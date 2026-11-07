import { describe, expect, it } from "bun:test";
import { jobStartCacheKey } from "./job-start";
import type { JobStartStateInput } from "./state";

type Files = JobStartStateInput["files"];

function file(over: Partial<Files[number]> & { filename: string }): Files[number] {
  return { status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@", ...over };
}

const key = (files: Files, commits: JobStartStateInput["commits"] = []) =>
  jobStartCacheKey("pr-1", "sha", { files, commits });

describe("jobStartCacheKey", () => {
  it("is stable across file ordering", () => {
    const a = [file({ filename: "a.ts" }), file({ filename: "b.ts" })];
    const b = [file({ filename: "b.ts" }), file({ filename: "a.ts" })];
    expect(key(a)).toBe(key(b));
  });

  it("ignores patch bodies", () => {
    // Callers truncate patches differently (cached preview vs. freshly-resolved run), so a patch-sensitive key would always miss.
    const a = [file({ filename: "a.ts", patch: "@@ -1 +1 @@ short" })];
    const b = [file({ filename: "a.ts", patch: "@@ -1 +1 @@ a much longer body …" })];
    expect(key(a)).toBe(key(b));
  });

  it("changes when the file set changes", () => {
    const base = [file({ filename: "a.ts" })];
    expect(key(base)).not.toBe(key([...base, file({ filename: "b.ts" })]));
  });

  it("changes when a file's line counts change", () => {
    // Same paths, different content: a rewrite without an added file must not reuse old sizing.
    const a = [file({ filename: "a.ts", additions: 3, deletions: 1 })];
    const b = [file({ filename: "a.ts", additions: 90, deletions: 40 })];
    expect(key(a)).not.toBe(key(b));
  });

  it("changes when a file's status changes", () => {
    const a = [file({ filename: "a.ts", status: "modified" })];
    const b = [file({ filename: "a.ts", status: "added" })];
    expect(key(a)).not.toBe(key(b));
  });

  it("changes when the commit subjects the state carries change", () => {
    const files = [file({ filename: "a.ts" })];
    expect(key(files, [{ message: "feat: a" }])).not.toBe(key(files, [{ message: "fix: a" }]));
    expect(key(files, [])).not.toBe(key(files, [{ message: "feat: a" }]));
  });

  it("ignores commit message bodies, which the state leaves out", () => {
    const files = [file({ filename: "a.ts" })];
    expect(key(files, [{ message: "feat: a\n\nlong body" }])).toBe(
      key(files, [{ message: "feat: a" }]),
    );
  });

  it("pins the diff, not just the head SHA", () => {
    // The poller advances head_sha before invalidating the diff cache; keying on SHA alone
    // would let a preview write an old diff's answer under the new SHA, never self-correcting.
    const stale = jobStartCacheKey("pr-1", "newsha", {
      files: [file({ filename: "a.ts" })],
      commits: [],
    });
    const fresh = jobStartCacheKey("pr-1", "newsha", {
      files: [file({ filename: "a.ts" }), file({ filename: "b.ts" })],
      commits: [],
    });
    expect(stale).not.toBe(fresh);
  });
});
