import { describe, expect, it } from "bun:test";
import type { CommentThread, ThreadMessage, WalkthroughIssue } from "@revv/shared";
import { GitHubApiError, GitHubNetworkError } from "../domain/errors";
import type { CachedDiffFile } from "./DiffCache";
import { isExistingPendingReviewError, planReviewComments, reviewBody } from "./review-submit";

describe("isExistingPendingReviewError", () => {
  it("matches GitHub's pending-review refusal", () => {
    expect(
      isExistingPendingReviewError(
        new GitHubApiError({
          status: 422,
          cause:
            '422 Unprocessable Entity: {"errors":["User can only have one pending review per pull request"]}',
        }),
      ),
    ).toBe(true);
  });

  it("does not match other refusals or transport failures", () => {
    expect(
      isExistingPendingReviewError(
        new GitHubApiError({ status: 422, cause: "422 Unprocessable Entity: validation failed" }),
      ),
    ).toBe(false);
    expect(
      isExistingPendingReviewError(new GitHubNetworkError({ cause: "pending review timed out" })),
    ).toBe(false);
  });
});

function thread(overrides: Partial<CommentThread> & { id: string }): CommentThread {
  return {
    reviewSessionId: "s1",
    filePath: "src/a.ts",
    startLine: 10,
    endLine: 10,
    diffSide: "new",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    externalThreadId: null,
    externalCommentId: null,
    lastSyncedAt: null,
    walkthroughIssueId: null,
    ...overrides,
  };
}

function message(threadId: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: `${threadId}-m`,
    threadId,
    authorRole: "reviewer",
    authorName: "me",
    authorLogin: "me",
    authorAvatarContent: null,
    body: "Please rename this.",
    messageType: "comment",
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    externalId: null,
    ...overrides,
  };
}

function file(path: string, patch: string | null = null): CachedDiffFile {
  return {
    path,
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch,
    fetchedAt: "",
  };
}

function plan(
  threads: CommentThread[],
  messages: Record<string, ThreadMessage[]>,
  cachedFiles: CachedDiffFile[] | null = null,
  issueIds: readonly string[] = [],
) {
  return planReviewComments(
    { threads, messages },
    { threadIds: new Set(threads.map((t) => t.id)), issueIds: new Set(issueIds) },
    cachedFiles,
    "me",
  );
}

describe("planReviewComments", () => {
  it("posts chosen local threads, ranged ones with a start line", () => {
    const { posted } = plan(
      [thread({ id: "t1" }), thread({ id: "t2", startLine: 3, endLine: 7, diffSide: "old" })],
      { t1: [message("t1")], t2: [message("t2", { body: "Range." })] },
    );
    expect(posted.map((p) => p.comment)).toEqual([
      { path: "src/a.ts", body: "Please rename this.", line: 10, side: "RIGHT" },
      { path: "src/a.ts", body: "Range.", line: 7, side: "LEFT", startLine: 3 },
    ]);
  });

  it("leaves out threads that weren't chosen, resolved threads and threads already on GitHub", () => {
    const threads = [
      thread({ id: "unchosen" }),
      thread({ id: "resolved", status: "resolved" }),
      thread({ id: "synced", externalCommentId: "123" }),
    ];
    const messages = Object.fromEntries(threads.map((t) => [t.id, [message(t.id)]]));
    const result = planReviewComments(
      { threads, messages },
      { threadIds: new Set(["resolved", "synced"]), issueIds: new Set() },
      null,
      "me",
    );
    expect(result).toEqual({ posted: [], skippedComments: [] });
  });

  it("holds back a comment on a file the diff no longer has, naming it", () => {
    const { posted, skippedComments } = plan(
      [thread({ id: "stale", filePath: "gone.ts" })],
      { stale: [message("stale")] },
      [file("src/a.ts")],
    );
    expect(posted).toEqual([]);
    expect(skippedComments).toEqual([
      {
        threadId: "stale",
        path: "gone.ts",
        line: 10,
        reason: "the file is no longer part of the diff",
      },
    ]);
  });

  it("keeps every file while no diff is cached", () => {
    const { posted } = plan([thread({ id: "t3", filePath: "any.ts" })], { t3: [message("t3")] });
    expect(posted.map((p) => p.threadId)).toEqual(["t3"]);
  });

  it("joins a thread's publishable drafts into one comment and remembers which they were", () => {
    const { posted } = plan(
      [thread({ id: "t4", walkthroughIssueId: "issue-1" })],
      {
        t4: [
          message("t4", { id: "a", body: "First." }),
          message("t4", { id: "b", authorRole: "coder", authorLogin: null, body: "Agent reply." }),
          message("t4", { id: "c", authorRole: "ai_agent", body: "Second." }),
          message("t4", { id: "d", body: "   " }),
        ],
      },
      null,
      ["issue-1"],
    );
    expect(posted).toEqual([
      {
        threadId: "t4",
        draftIds: ["a", "c"],
        comment: { path: "src/a.ts", body: "First.\n\nSecond.", line: 10, side: "RIGHT" },
      },
    ]);
  });
});

describe("Revv's issue comments", () => {
  const aiThread = thread({ id: "ai", walkthroughIssueId: "issue-1" });
  const aiComment = message("ai", { id: "ai-m", authorRole: "ai_agent", body: "Leaks." });

  it("stay local unless their issue is chosen for the review", () => {
    expect(plan([aiThread], { ai: [aiComment] }).posted).toEqual([]);
    expect(plan([aiThread], { ai: [aiComment] }, null, ["issue-2"]).posted).toEqual([]);
  });

  it("go up with their issue", () => {
    const { posted } = plan([aiThread], { ai: [aiComment] }, null, ["issue-1"]);
    expect(posted.map((p) => p.draftIds)).toEqual([["ai-m"]]);
  });

  it("stay behind when the reviewer's own reply on them goes up", () => {
    const { posted } = plan([aiThread], {
      ai: [aiComment, message("ai", { id: "mine", body: "Agreed." })],
    });
    expect(posted).toEqual([
      {
        threadId: "ai",
        draftIds: ["mine"],
        comment: { path: "src/a.ts", body: "Agreed.", line: 10, side: "RIGHT" },
      },
    ]);
  });
});

describe("reviewBody", () => {
  const issue = (overrides: Partial<WalkthroughIssue>): WalkthroughIssue => ({
    id: "i",
    severity: "warning",
    title: "Title",
    description: "Why.",
    blockIds: [],
    ...overrides,
  });

  it("is empty without issues", () => {
    expect(reviewBody([])).toBe("");
  });

  it("lists issues with severity tags and locations", () => {
    expect(
      reviewBody([
        issue({ severity: "critical", filePath: "a.ts", startLine: 1, endLine: 4 }),
        issue({ severity: "info", filePath: "b.ts" }),
        issue({}),
      ]),
    ).toBe(
      [
        "### Walkthrough issues",
        "- `[CRITICAL]` **Title** (`a.ts:1–4`)\n  Why.",
        "- `[INFO]` **Title** (`b.ts`)\n  Why.",
        "- `[WARNING]` **Title**\n  Why.",
      ].join("\n\n"),
    );
  });
});
