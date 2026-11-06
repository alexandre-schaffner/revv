import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { DbService } from "../services/Db";
import { checkOwnership } from "./ownership";

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

/** Two users, each with one repository holding one PR, review session and thread. */
function seededDb(): Db {
  const db = createDb(":memory:");
  databases.push(db);
  const now = "2026-09-22T12:00:00.000Z";
  for (const n of [1, 2]) {
    db.$client.run(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [`user-${n}`, `User ${n}`, `u${n}@example.com`, 1, Date.now(), Date.now()],
    );
    db.$client.run(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [`account-${n}`, `gh-${n}`, "github:github.com", `user-${n}`, Date.now(), Date.now()],
    );
    db.$client.run(
      "INSERT INTO repositories (id, owner, name, full_name, added_at, account_id) VALUES (?, ?, ?, ?, ?, ?)",
      [`repo-${n}`, "acme", `widget-${n}`, `acme/widget-${n}`, now, `account-${n}`],
    );
    db.$client.run(
      `INSERT INTO pull_requests
        (id, external_id, repository_id, title, author_login, source_branch, target_branch, url, created_at, updated_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`pr-${n}`, n, `repo-${n}`, "Fix", "author", "feature", "main", "https://x", now, now, now],
    );
    db.$client.run(
      "INSERT INTO review_sessions (id, pull_request_id, started_at, status) VALUES (?, ?, ?, ?)",
      [`session-${n}`, `pr-${n}`, now, "active"],
    );
    db.$client.run(
      `INSERT INTO comment_threads (id, review_session_id, file_path, start_line, end_line, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`thread-${n}`, `session-${n}`, "a.ts", 1, 1, "pending_coder", now],
    );
  }
  return db;
}

const check = (
  db: Db,
  fields: Parameters<typeof checkOwnership>[0],
  request: { params?: Record<string, string>; body?: unknown },
) =>
  Effect.runPromiseExit(
    checkOwnership(fields, { params: request.params ?? {}, body: request.body }, "user-1").pipe(
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );

describe("checkOwnership", () => {
  it("lets through ids in the user's own repositories", async () => {
    const db = seededDb();
    const exit = await check(
      db,
      { id: "pull request", sessionId: "review session", threadId: "thread", repoId: "repository" },
      { params: { id: "pr-1", sessionId: "session-1", threadId: "thread-1", repoId: "repo-1" } },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("answers NotFound for another user's pull request, session, thread or repository", async () => {
    const db = seededDb();
    for (const [kind, id] of [
      ["pull request", "pr-2"],
      ["review session", "session-2"],
      ["thread", "thread-2"],
      ["repository", "repo-2"],
    ] as const) {
      const exit = await check(db, { id: kind }, { params: { id } });
      expect(exit).toEqual(Exit.fail(expect.objectContaining({ _tag: "NotFoundError", id })));
    }
  });

  it("answers NotFound for an id that names nothing", async () => {
    const exit = await check(seededDb(), { id: "pull request" }, { params: { id: "missing" } });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("checks a field the JSON body carries, and skips a field the request lacks", async () => {
    const db = seededDb();
    const fromBody = await check(db, { prId: "pull request" }, { body: { prId: "pr-2" } });
    expect(Exit.isFailure(fromBody)).toBe(true);
    const absent = await check(db, { prId: "pull request" }, { body: { other: "pr-2" } });
    expect(Exit.isSuccess(absent)).toBe(true);
  });
});
