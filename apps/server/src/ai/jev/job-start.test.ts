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
    // Callers truncate patches differently — the preview reads the cached
    // diff, the run reads a freshly-resolved one — so a patch-sensitive
    // fingerprint would miss on every single lookup.
    const a = [file({ filename: "a.ts", patch: "@@ -1 +1 @@ short" })];
    const b = [file({ filename: "a.ts", patch: "@@ -1 +1 @@ a much longer body …" })];
    expect(diffFingerprint(a)).toBe(diffFingerprint(b));
  });

  it("changes when the file set changes", () => {
    const base = [file({ filename: "a.ts" })];
    expect(diffFingerprint(base)).not.toBe(diffFingerprint([...base, file({ filename: "b.ts" })]));
  });

  it("changes when a file's line counts change", () => {
    // The case that matters: same paths, different content. A pull that
    // rewrites a file without adding one must not reuse the old sizing.
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
    // The poller advances `pull_requests.head_sha` before it invalidates the
    // diff cache. Keying on the SHA alone would let a preview running in
    // that window write an answer about the *old* diff under the *new* SHA —
    // and these entries are immutable, so it would never self-correct.
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
