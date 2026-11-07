import { describe, expect, it } from "bun:test";
import type { CommentThread, ThreadMessage } from "@revv/shared";
import { GitHubApiError, GitHubNetworkError } from "../../../domain/errors";
import type { CachedDiffFile } from "../../../services/DiffCache";
import { isExistingPendingReviewError, planReviewComments } from "./github-submit";

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
) {
  return planReviewComments({ threads, messages }, new Set(threads.map((t) => t.id)), cachedFiles);
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
    const result = planReviewComments({ threads, messages }, new Set(["resolved", "synced"]), null);
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
    const { posted } = plan([thread({ id: "t4" })], {
      t4: [
        message("t4", { id: "a", body: "First." }),
        message("t4", { id: "b", authorRole: "coder", body: "Author note." }),
        message("t4", { id: "c", authorRole: "ai_agent", body: "Second." }),
        message("t4", { id: "d", body: "   " }),
      ],
    });
    expect(posted).toEqual([
      {
        threadId: "t4",
        draftIds: ["a", "c"],
        comment: { path: "src/a.ts", body: "First.\n\nSecond.", line: 10, side: "RIGHT" },
      },
    ]);
  });
});
