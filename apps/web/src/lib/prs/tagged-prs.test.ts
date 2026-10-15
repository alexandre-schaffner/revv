import { describe, expect, it } from "bun:test";
import type { PullRequest } from "@revv/shared";
import {
  compareTaggedRows,
  reasonFor,
  sortOptionFor,
  TAGGED_SORT_OPTIONS,
  type TaggedRow,
  toTaggedRows,
} from "./tagged-prs";

const ME = "alex";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  id: "pr-1",
  externalId: 1,
  repositoryId: "repo-1",
  title: "a title",
  body: null,
  authorLogin: "someone-else",
  authorAvatarContent: null,
  authorAvatarUrl: null,
  requestedReviewers: [],
  mentionedUsers: [],
  status: "open",
  reviewStatus: "pending",
  isDraft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  url: "https://example.com/pr/1",
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  headSha: null,
  baseSha: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  fetchedAt: "2026-09-01T00:00:00.000Z",
  closedAt: null,
  ...over,
});

const row = (over: Partial<PullRequest>, reason: TaggedRow["reason"]): TaggedRow => ({
  pr: pr(over),
  reason,
});

describe("reasonFor", () => {
  it("classifies a requested review", () => {
    expect(reasonFor(pr({ requestedReviewers: [ME] }), ME)).toBe("review");
  });

  it("classifies your own PR", () => {
    expect(reasonFor(pr({ authorLogin: ME }), ME)).toBe("yours");
  });

  it("classifies a bare mention", () => {
    expect(reasonFor(pr({ mentionedUsers: [ME] }), ME)).toBe("mentioned");
  });

  it("ranks a requested review above authorship", () => {
    // Not reachable on github.com today, but the precedence must be explicit
    // rather than depend on which branch happens to run first.
    expect(reasonFor(pr({ authorLogin: ME, requestedReviewers: [ME] }), ME)).toBe("review");
  });

  it("ranks authorship above a mention", () => {
    // Authors get @-mentioned in their own comment threads constantly; without
    // this precedence most of your own work would read as "Mentioned".
    expect(reasonFor(pr({ authorLogin: ME, mentionedUsers: [ME] }), ME)).toBe("yours");
  });

  // GitHub logins are case-insensitive, and the viewer's casing comes from a
  // different endpoint than the PR's. An exact match drops rows out of the
  // queue with no way for the user to tell why.
  it("matches every reason case-insensitively", () => {
    expect(reasonFor(pr({ requestedReviewers: ["Alex"] }), ME)).toBe("review");
    expect(reasonFor(pr({ authorLogin: "ALEX" }), ME)).toBe("yours");
    expect(reasonFor(pr({ mentionedUsers: ["aLeX"] }), ME)).toBe("mentioned");
  });

  it("returns null when the login isn't involved", () => {
    expect(reasonFor(pr(), ME)).toBeNull();
  });

  it("returns null for an unresolved login rather than guessing", () => {
    expect(reasonFor(pr({ authorLogin: ME }), null)).toBeNull();
    expect(reasonFor(pr({ mentionedUsers: [ME] }), "")).toBeNull();
  });
});

describe("toTaggedRows", () => {
  it("keeps only involved PRs and attaches the reason", () => {
    const rows = toTaggedRows(
      [
        pr({ id: "a", requestedReviewers: [ME] }),
        pr({ id: "b" }),
        pr({ id: "c", authorLogin: ME }),
      ],
      ME,
    );
    expect(rows.map((r) => [r.pr.id, r.reason])).toEqual([
      ["a", "review"],
      ["c", "yours"],
    ]);
  });

  it("yields nothing while the login is unresolved", () => {
    expect(toTaggedRows([pr({ authorLogin: ME })], null)).toEqual([]);
  });
});

describe("compareTaggedRows", () => {
  const review = row({ id: "r", updatedAt: "2026-09-01T00:00:00.000Z" }, "review");
  const yours = row({ id: "y", updatedAt: "2026-09-05T00:00:00.000Z" }, "yours");
  const mentioned = row({ id: "m", updatedAt: "2026-09-09T00:00:00.000Z" }, "mentioned");

  const sorted = (rows: TaggedRow[], key: Parameters<typeof compareTaggedRows>[2], dir = "asc") =>
    [...rows]
      .sort((a, b) => compareTaggedRows(a, b, key, dir as "asc" | "desc"))
      .map((r) => r.pr.id);

  it("default sort is relevance, newest first within a reason", () => {
    // Note this deliberately ignores recency across reasons: the stale
    // review-request still outranks the fresh drive-by mention.
    expect(sorted([mentioned, yours, review], "default")).toEqual(["r", "y", "m"]);
  });

  it("default sort ignores the direction argument", () => {
    expect(sorted([mentioned, yours, review], "default", "desc")).toEqual(["r", "y", "m"]);
  });

  it("sorts by updated date in both directions", () => {
    expect(sorted([review, mentioned, yours], "updated", "asc")).toEqual(["r", "y", "m"]);
    expect(sorted([review, mentioned, yours], "updated", "desc")).toEqual(["m", "y", "r"]);
  });

  it("sorts by PR number", () => {
    const rows = [
      row({ id: "hi", externalId: 30 }, "yours"),
      row({ id: "lo", externalId: 4 }, "yours"),
    ];
    expect(sorted(rows, "pr", "asc")).toEqual(["lo", "hi"]);
    expect(sorted(rows, "pr", "desc")).toEqual(["hi", "lo"]);
  });

  it("breaks ties by recency then PR number, so the order is total", () => {
    const older = row(
      { id: "older", externalId: 9, updatedAt: "2026-09-01T00:00:00.000Z" },
      "yours",
    );
    const newer = row(
      { id: "newer", externalId: 2, updatedAt: "2026-09-02T00:00:00.000Z" },
      "yours",
    );
    // Same author, same branch, same reason — only the tiebreak separates them,
    // and it must not flip when the input order does.
    expect(sorted([older, newer], "default")).toEqual(["newer", "older"]);
    expect(sorted([newer, older], "default")).toEqual(["newer", "older"]);
  });

  it("breaks a full tie by PR number, descending", () => {
    const at = "2026-09-03T00:00:00.000Z";
    const low = row({ id: "low", externalId: 1, updatedAt: at }, "yours");
    const high = row({ id: "high", externalId: 2, updatedAt: at }, "yours");
    expect(sorted([low, high], "default")).toEqual(["high", "low"]);
  });

  // ── Wire-type robustness ──────────────────────────────────────────────────
  // The DTO types these fields as `string`, but the Eden treaty client's
  // JSON reviver turns anything date-shaped into a `Date` while the SSE path
  // leaves it a string, so the store array holds both. Comparators must not
  // assume a string. Regression: `updatedAt.localeCompare is not a function`
  // crashed the whole repo page.
  const asWire = (v: unknown) => v as unknown as string;

  it("sorts by updated when the wire gave Dates instead of strings", () => {
    const early = row(
      { id: "early", updatedAt: asWire(new Date("2026-09-01T00:00:00Z")) },
      "yours",
    );
    const late = row({ id: "late", updatedAt: asWire(new Date("2026-09-08T00:00:00Z")) }, "yours");
    expect(sorted([late, early], "updated", "asc")).toEqual(["early", "late"]);
    expect(sorted([early, late], "updated", "desc")).toEqual(["late", "early"]);
  });

  it("sorts by updated across a mix of Date and string values", () => {
    const asDate = row({ id: "d", updatedAt: asWire(new Date("2026-09-05T00:00:00Z")) }, "yours");
    const asStr = row({ id: "s", updatedAt: "2026-09-01T00:00:00.000Z" }, "yours");
    expect(sorted([asDate, asStr], "updated", "asc")).toEqual(["s", "d"]);
  });

  it("uses the same normalisation in the tiebreak", () => {
    const older = row(
      { id: "older", externalId: 9, updatedAt: asWire(new Date("2026-09-01Z")) },
      "yours",
    );
    const newer = row(
      { id: "newer", externalId: 2, updatedAt: asWire(new Date("2026-09-02Z")) },
      "yours",
    );
    expect(sorted([older, newer], "default")).toEqual(["newer", "older"]);
  });

  it("treats an unparseable timestamp as oldest instead of poisoning the sort", () => {
    const broken = row({ id: "broken", updatedAt: "not-a-date" }, "yours");
    const good = row({ id: "good", updatedAt: "2026-09-01T00:00:00.000Z" }, "yours");
    expect(sorted([good, broken], "updated", "asc")).toEqual(["broken", "good"]);
  });
});

describe("TAGGED_SORT_OPTIONS", () => {
  it("has unique ids, since the id is the select's value", () => {
    const ids = TAGGED_SORT_OPTIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leads with relevance, so the default option is the first one", () => {
    expect(TAGGED_SORT_OPTIONS[0]).toMatchObject({ id: "relevance", key: "default" });
  });

  it("offers both directions for every field-backed key", () => {
    const dirsByKey = new Map<string, Set<string>>();
    for (const o of TAGGED_SORT_OPTIONS) {
      if (o.key === "default") continue;
      dirsByKey.set(o.key, (dirsByKey.get(o.key) ?? new Set()).add(o.dir));
    }
    expect([...dirsByKey.keys()].sort()).toEqual(["pr", "updated"]);
    for (const dirs of dirsByKey.values()) expect([...dirs].sort()).toEqual(["asc", "desc"]);
  });
});

describe("sortOptionFor", () => {
  it("resolves an id to its (key, dir) pair", () => {
    expect(sortOptionFor("updated-asc")).toMatchObject({ key: "updated", dir: "asc" });
  });

  it("falls back to relevance rather than leaving the list unsorted", () => {
    // A stale value persisted before an option was renamed must not strand the
    // list with `undefined` as its comparator input.
    expect(sortOptionFor("gone" as never).id).toBe("relevance");
  });
});
