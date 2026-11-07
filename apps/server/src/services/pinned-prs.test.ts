import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { DbService } from "./Db";
import { listPinned, pinPr, unpinPr } from "./pinned-prs";

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

function seededDb(): Db {
  const db = createDb(":memory:");
  databases.push(db);
  const now = "2026-11-07T12:00:00.000Z";
  db.$client.run(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["user-1", "User", "u@example.com", 1, Date.now(), Date.now()],
  );
  db.$client.run(
    "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["account-1", "gh-1", "github:github.com", "user-1", Date.now(), Date.now()],
  );
  db.$client.run(
    "INSERT INTO repositories (id, owner, name, full_name, added_at, account_id) VALUES (?, ?, ?, ?, ?, ?)",
    ["repo-1", "acme", "widget", "acme/widget", now, "account-1"],
  );
  for (const n of [1, 2, 3]) {
    db.$client.run(
      `INSERT INTO pull_requests
        (id, external_id, repository_id, title, author_login, source_branch, target_branch, url, created_at, updated_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`pr-${n}`, n, "repo-1", "Fix", "author", "feature", "main", "https://x", now, now, now],
    );
  }
  return db;
}

const run = <A, E>(db: Db, effect: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(DbService, { db }))));

describe("pinned PRs", () => {
  it("keeps several pins made in the same second, in the order they were made", async () => {
    const db = seededDb();
    setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
    try {
      await run(db, pinPr("user-1", "pr-3"));
      await run(db, pinPr("user-1", "pr-1"));
      await run(db, pinPr("user-1", "pr-2"));
    } finally {
      setSystemTime();
    }
    expect(await run(db, listPinned("user-1"))).toEqual(["pr-3", "pr-1", "pr-2"]);
  });

  it("re-pinning a pinned PR keeps its first pin", async () => {
    const db = seededDb();
    await run(db, pinPr("user-1", "pr-1"));
    await run(db, pinPr("user-1", "pr-2"));
    await run(db, pinPr("user-1", "pr-1"));
    expect(await run(db, listPinned("user-1"))).toEqual(["pr-1", "pr-2"]);
    await run(db, unpinPr("user-1", "pr-1"));
    expect(await run(db, listPinned("user-1"))).toEqual(["pr-2"]);
  });
});
