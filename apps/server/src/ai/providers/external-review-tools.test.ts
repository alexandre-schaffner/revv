import { afterEach, describe, expect, it } from "bun:test";
import {
  EXTERNAL_AGENT_PROVIDER_NAMES,
  type ExternalAgentProvider,
  type ThreadEventMessage,
  type WalkthroughStreamEvent,
} from "@revv/shared";
import { createDb, type Db } from "../../db";
import {
  EXTERNAL_REVIEW_TOOL_SPECS,
  type ExternalReviewToolContext,
} from "./external-review-tools";

const HEAD_SHA = "a".repeat(40);
const databases: Db[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

function seededDb(): Db {
  const db = createDb(":memory:");
  databases.push(db);
  const now = "2026-09-22T12:00:00.000Z";
  db.$client.run(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["user-1", "Reviewer", "reviewer@example.com", 1, Date.now(), Date.now()],
  );
  db.$client.run(
    "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["account-1", "github-user", "github:github.com", "user-1", Date.now(), Date.now()],
  );
  db.$client.run(
    "INSERT INTO repositories (id, owner, name, full_name, added_at, account_id) VALUES (?, ?, ?, ?, ?, ?)",
    ["repo-1", "acme", "widget", "acme/widget", now, "account-1"],
  );
  db.$client.run(
    `INSERT INTO pull_requests
      (id, external_id, repository_id, title, author_login, source_branch, target_branch, url, head_sha, created_at, updated_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "pr-1",
      42,
      "repo-1",
      "Fix the widget",
      "author",
      "feature",
      "main",
      "https://github.com/acme/widget/pull/42",
      HEAD_SHA,
      now,
      now,
      now,
    ],
  );
  db.$client.run(
    "INSERT INTO review_sessions (id, pull_request_id, started_at, status) VALUES (?, ?, ?, ?)",
    ["session-1", "pr-1", now, "active"],
  );
  db.$client.run(
    `INSERT INTO walkthroughs
      (id, review_session_id, pull_request_id, status, last_completed_phase, generated_at, completed_at, model_used, pr_head_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["walkthrough-1", "session-1", "pr-1", "complete", "D", now, now, "test", HEAD_SHA],
  );
  db.$client.run(
    `INSERT INTO walkthrough_issues
      (id, walkthrough_id, "order", severity, title, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["issue-1", "walkthrough-1", 0, "warning", "Handle failure", "Retry the call", now],
  );
  db.$client.run(
    `INSERT INTO comment_threads
      (id, review_session_id, file_path, start_line, end_line, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["thread-1", "session-1", "src/widget.ts", 10, 10, "pending_coder", now],
  );
  return db;
}

function context(db: Db, provider: ExternalAgentProvider = "claude-code") {
  const walkthroughEvents: WalkthroughStreamEvent[] = [];
  const threadEvents: ThreadEventMessage[] = [];
  const pushedReplies: string[] = [];
  const pushedStatuses: string[] = [];
  const value = {
    db,
    prId: "pr-1",
    prHeadSha: HEAD_SHA,
    userId: "user-1",
    actor: provider,
    provider,
    providerName: EXTERNAL_AGENT_PROVIDER_NAMES[provider],
    integrationId: "integration-1",
    emit: (_walkthroughId, event) => walkthroughEvents.push(event),
    broadcastThreadEvent: (event) => threadEvents.push(event),
    pushReply: async (messageId) => {
      pushedReplies.push(messageId);
    },
    pushThreadStatus: async (threadId) => {
      pushedStatuses.push(threadId);
    },
  } satisfies ExternalReviewToolContext;
  return { value, walkthroughEvents, threadEvents, pushedReplies, pushedStatuses };
}

function tool(name: string) {
  const spec = EXTERNAL_REVIEW_TOOL_SPECS.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`Missing external review tool: ${name}`);
  return spec;
}

describe("external review tools", () => {
  it("records issue resolution once and treats an identical retry as a no-op", async () => {
    const db = seededDb();
    const ctx = context(db);
    const input = {
      issue_id: "issue-1",
      expected_head_sha: HEAD_SHA,
      status: "addressed",
      explanation: "The call now retries transient failures.",
      evidence: ["tests pass", "src/widget.ts", "tests pass"],
      resolving_commit_sha: "b".repeat(40),
    };

    const first = await tool("record_issue_resolution").handler(ctx.value, input);
    const rowAfterFirst = db.$client
      .query(
        "SELECT resolution_status, resolution_evidence, resolved_at, resolved_by FROM walkthrough_issues WHERE id = ?",
      )
      .get("issue-1") as Record<string, unknown>;
    const second = await tool("record_issue_resolution").handler(ctx.value, input);
    const rowAfterSecond = db.$client
      .query("SELECT resolved_at FROM walkthrough_issues WHERE id = ?")
      .get("issue-1") as Record<string, unknown>;

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(rowAfterFirst).toMatchObject({
      resolution_status: "addressed",
      resolution_evidence: '["src/widget.ts","tests pass"]',
      resolved_by: "claude-code",
    });
    expect(rowAfterSecond.resolved_at).toBe(rowAfterFirst.resolved_at);
    expect(ctx.walkthroughEvents).toHaveLength(1);
  });

  it("attributes writes to the calling agent", async () => {
    const db = seededDb();
    const ctx = context(db, "codex");

    await tool("record_issue_resolution").handler(ctx.value, {
      issue_id: "issue-1",
      expected_head_sha: HEAD_SHA,
      status: "addressed",
      explanation: "Retries now.",
      evidence: ["tests pass"],
      resolving_commit_sha: null,
    });
    await tool("reply_to_comment").handler(ctx.value, {
      thread_id: "thread-1",
      expected_head_sha: HEAD_SHA,
      body: "Done.",
      idempotency_key: "codex-reply-1",
      publish_to_github: false,
    });

    const issue = db.$client
      .query("SELECT resolved_by FROM walkthrough_issues WHERE id = ?")
      .get("issue-1") as Record<string, unknown>;
    const walkthrough = db.$client
      .query("SELECT last_edited_by FROM walkthroughs WHERE id = ?")
      .get("walkthrough-1") as Record<string, unknown>;
    const message = db.$client
      .query("SELECT author_name FROM thread_messages WHERE thread_id = ?")
      .get("thread-1") as Record<string, unknown>;

    expect(issue.resolved_by).toBe("codex");
    expect(walkthrough.last_edited_by).toBe("codex");
    expect(message.author_name).toBe("Codex");
  });

  it("never mutates a walkthrough issue already submitted to GitHub", async () => {
    const db = seededDb();
    db.$client.run("UPDATE walkthrough_issues SET submitted_at = ? WHERE id = ?", [
      "2026-09-22T12:30:00.000Z",
      "issue-1",
    ]);
    const ctx = context(db);

    const result = await tool("record_issue_resolution").handler(ctx.value, {
      issue_id: "issue-1",
      expected_head_sha: HEAD_SHA,
      status: "addressed",
      explanation: "Fixed",
      evidence: ["tests pass"],
      resolving_commit_sha: null,
    });
    const row = db.$client
      .query("SELECT resolution_status FROM walkthrough_issues WHERE id = ?")
      .get("issue-1") as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(row.resolution_status).toBe("open");
    expect(ctx.walkthroughEvents).toHaveLength(0);
  });

  it("deduplicates a retried local comment reply by integration key", async () => {
    const db = seededDb();
    const ctx = context(db);
    const input = {
      thread_id: "thread-1",
      expected_head_sha: HEAD_SHA,
      body: "Implemented and verified the retry path.",
      idempotency_key: "retry-fix-42",
      publish_to_github: false,
    };

    await tool("reply_to_comment").handler(ctx.value, input);
    await tool("reply_to_comment").handler(ctx.value, input);

    const messages = db.$client
      .query("SELECT author_role, body FROM thread_messages WHERE thread_id = ?")
      .all("thread-1");
    const thread = db.$client
      .query("SELECT status FROM comment_threads WHERE id = ?")
      .get("thread-1") as Record<string, unknown>;
    expect(messages).toEqual([
      { author_role: "coder", body: "Implemented and verified the retry path." },
    ]);
    expect(thread.status).toBe("pending_reviewer");
    expect(ctx.threadEvents).toHaveLength(2);
    expect(ctx.pushedReplies).toHaveLength(0);
  });

  it("keeps a status update local when the thread has no GitHub identity", async () => {
    const db = seededDb();
    const ctx = context(db);

    const result = await tool("update_comment_status").handler(ctx.value, {
      thread_id: "thread-1",
      expected_head_sha: HEAD_SHA,
      status: "resolved",
      publish_to_github: true,
    });
    const thread = db.$client
      .query("SELECT status, resolved_at FROM comment_threads WHERE id = ?")
      .get("thread-1") as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(thread.status).toBe("resolved");
    expect(thread.resolved_at).toBeString();
    expect(ctx.pushedStatuses).toHaveLength(0);
  });
});
