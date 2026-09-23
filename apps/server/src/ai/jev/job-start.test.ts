import { describe, expect, it } from "bun:test";
import { diffFingerprint, jobStartCacheKey } from "./job-start";
import type { JobStartStateInput } from "./state";

type Files = JobStartStateInput["files"];

function file(over: Partial<Files[number]> & { filename: string }): Files[number] {
  return { status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@", ...over };
}

describe("diffFingerprint", () => {
  it("is stable across file ordering", () => {
    const a = [file({ filename: "a.ts" }), file({ filename: "b.ts" })];
    const b = [file({ filename: "b.ts" }), file({ filename: "a.ts" })];
    expect(diffFingerprint(a)).toBe(diffFingerprint(b));
  });

  it("ignores patch bodies", () => {
    // Callers truncate patches differently (cached preview vs. freshly-resolved run), so a patch-sensitive fingerprint would always miss.
    const a = [file({ filename: "a.ts", patch: "@@ -1 +1 @@ short" })];
    const b = [file({ filename: "a.ts", patch: "@@ -1 +1 @@ a much longer body …" })];
    expect(diffFingerprint(a)).toBe(diffFingerprint(b));
  });

  it("changes when the file set changes", () => {
    const base = [file({ filename: "a.ts" })];
    expect(diffFingerprint(base)).not.toBe(diffFingerprint([...base, file({ filename: "b.ts" })]));
  });

  it("changes when a file's line counts change", () => {
    // Same paths, different content: a rewrite without an added file must not reuse old sizing.
    const a = [file({ filename: "a.ts", additions: 3, deletions: 1 })];
    const b = [file({ filename: "a.ts", additions: 90, deletions: 40 })];
    expect(diffFingerprint(a)).not.toBe(diffFingerprint(b));
  });

  it("changes when a file's status changes", () => {
    const a = [file({ filename: "a.ts", status: "modified" })];
    const b = [file({ filename: "a.ts", status: "added" })];
    expect(diffFingerprint(a)).not.toBe(diffFingerprint(b));
  });
});

describe("jobStartCacheKey", () => {
  it("pins the diff, not just the head SHA", () => {
    // The poller advances head_sha before invalidating the diff cache; keying on SHA alone
    // would let a preview write an old diff's answer under the new SHA, never self-correcting.
    const stale = jobStartCacheKey("pr-1", "newsha", diffFingerprint([file({ filename: "a.ts" })]));
    const fresh = jobStartCacheKey(
      "pr-1",
      "newsha",
      diffFingerprint([file({ filename: "a.ts" }), file({ filename: "b.ts" })]),
    );
    expect(stale).not.toBe(fresh);
  });

  it("is identical for the same PR, SHA and diff", () => {
    const files = [file({ filename: "a.ts" })];
    expect(jobStartCacheKey("pr-1", "sha", diffFingerprint(files))).toBe(
      jobStartCacheKey("pr-1", "sha", diffFingerprint([...files])),
    );
  });
});
