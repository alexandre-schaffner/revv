import { afterEach, describe, expect, it } from "bun:test";
import type { ServerEventMessage } from "@revv/shared";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";
import { Realtime, RealtimeLive } from "./Realtime";

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
  db.$client.run(
    `INSERT INTO pull_requests
      (id, external_id, repository_id, title, author_login, source_branch, target_branch, url, created_at, updated_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pr-1", 1, "repo-1", "Fix", "author", "feature", "main", "https://x", now, now, now],
  );
  return db;
}

const MSG: ServerEventMessage = { type: "repos:updated", data: { host: "github.com", repos: [] } };

async function sent(db: Db, push: Effect.Effect<void, never, Realtime>) {
  const deliveries: string[] = [];
  const broadcaster = Layer.succeed(Broadcaster, {
    register: () => Effect.succeed(() => undefined),
    broadcastToUser: (userId) => Effect.sync(() => void deliveries.push(userId)),
  });
  await Effect.runPromise(
    push.pipe(
      Effect.provide(
        RealtimeLive.pipe(
          Layer.provide(Layer.merge(broadcaster, Layer.succeed(DbService, { db }))),
        ),
      ),
    ),
  );
  return deliveries;
}

describe("Realtime", () => {
  it("addresses an account's, a repository's or a pull request's push to the user who owns it", async () => {
    const db = seededDb();
    db.$client.run(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["account-2", "gh-2", "github:ghe.example.com", "user-1", Date.now(), Date.now()],
    );
    expect(
      await sent(
        db,
        Effect.flatMap(Realtime, (r) => r.toRepo("repo-1", MSG)),
      ),
    ).toEqual(["user-1"]);
    expect(
      await sent(
        db,
        Effect.flatMap(Realtime, (r) => r.toPr("pr-1", MSG)),
      ),
    ).toEqual(["user-1"]);
    expect(
      await sent(
        db,
        Effect.flatMap(Realtime, (r) => r.toAccount("account-2", MSG)),
      ),
    ).toEqual(["user-1"]);
  });

  it("sends a user-wide signal once per user, however many of their accounts it names", async () => {
    const db = seededDb();
    db.$client.run(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["account-2", "gh-2", "github:ghe.example.com", "user-1", Date.now(), Date.now()],
    );
    expect(
      await sent(
        db,
        Effect.flatMap(Realtime, (r) =>
          r.toUsers(
            { userIds: ["user-1", "user-9"], ownersOf: ["account-1", "account-2"] },
            { type: "prs:sync-complete" },
          ),
        ),
      ),
    ).toEqual(["user-1", "user-9"]);
  });

  it("drops a push whose owner can't be resolved, without failing", async () => {
    const db = seededDb();
    expect(
      await sent(
        db,
        Effect.flatMap(Realtime, (r) => r.toPr("missing", MSG)),
      ),
    ).toEqual([]);
    db.$client.close();
    databases.length = 0;
    expect(
      await sent(
        db,
        Effect.flatMap(Realtime, (r) => r.toRepo("repo-1", MSG)),
      ),
    ).toEqual([]);
  });
});
