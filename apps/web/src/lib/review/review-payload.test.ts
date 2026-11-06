import { describe, expect, it } from "bun:test";
import type { CommentThread, ThreadMessage, WalkthroughIssue } from "@revv/shared";
import { reviewBody, reviewComments } from "./review-payload";

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
    codeSuggestion: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    externalId: null,
    ...overrides,
  };
}

describe("reviewComments", () => {
  const messages = new Map<string, ThreadMessage[]>();
  const messagesOf = (id: string) => messages.get(id) ?? [];

  it("posts unresolved local threads, ranged ones with a start line", () => {
    messages.set("t1", [message("t1")]);
    messages.set("t2", [message("t2", { body: "Range." })]);
    const comments = reviewComments(
      [thread({ id: "t1" }), thread({ id: "t2", startLine: 3, endLine: 7, diffSide: "old" })],
      messagesOf,
      new Set(),
    );
    expect(comments).toEqual([
      { path: "src/a.ts", body: "Please rename this.", line: 10, side: "RIGHT", threadId: "t1" },
      { path: "src/a.ts", body: "Range.", line: 7, side: "LEFT", startLine: 3, threadId: "t2" },
    ]);
  });

  it("skips resolved threads, threads already on GitHub and files no longer in the diff", () => {
    for (const id of ["resolved", "synced", "stale"]) messages.set(id, [message(id)]);
    const comments = reviewComments(
      [
        thread({ id: "resolved", status: "resolved" }),
        thread({ id: "synced", externalCommentId: "123" }),
        thread({ id: "stale", filePath: "gone.ts" }),
      ],
      messagesOf,
      new Set(["src/a.ts"]),
    );
    expect(comments).toEqual([]);
  });

  it("keeps every file while the diff hasn't loaded", () => {
    messages.set("t3", [message("t3")]);
    const comments = reviewComments(
      [thread({ id: "t3", filePath: "any.ts" })],
      messagesOf,
      new Set(),
    );
    expect(comments.map((c) => c.threadId)).toEqual(["t3"]);
  });

  it("joins only publishable drafts, and drops a thread with none", () => {
    messages.set("t4", [
      message("t4", { id: "a", body: "First." }),
      message("t4", { id: "b", body: "Synced.", externalId: "9" }),
      message("t4", { id: "c", body: "Second." }),
    ]);
    messages.set("t5", [message("t5", { authorRole: "coder" })]);
    const comments = reviewComments(
      [thread({ id: "t4" }), thread({ id: "t5" })],
      messagesOf,
      new Set(),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("First.\n\nSecond.");
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
