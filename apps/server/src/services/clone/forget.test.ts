import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../../db/index";
import { account, repositories } from "../../db/schema";
import { DbService } from "../Db";
import { ExternalIntegrations } from "../ExternalIntegrations";
import { GitHubAccounts } from "../github/accounts";
import { forgetAccount, forgetRepositories, forgetUser } from "./forget";
import { RepoCloneService } from "./RepoClone";

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

/** One user with an account on github.com and one on a GHE host, each tracking one repository. */
function seededDb(): Db {
  const db = createDb(":memory:");
  databases.push(db);
  const now = Date.now();
  db.$client.run(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["user-1", "User", "u@example.com", 1, now, now],
  );
  for (const [id, host] of [
    ["acc-dotcom", "github.com"],
    ["acc-ghe", "ghe.example.com"],
  ] as const) {
    db.$client.run(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, `gh-${id}`, `github:${host}`, "user-1", now, now],
    );
    db.$client.run(
      "INSERT INTO repositories (id, owner, name, full_name, added_at, account_id) VALUES (?, ?, ?, ?, ?, ?)",
      [`repo-${id}`, "acme", id, `acme/${id}`, "2026-11-01T00:00:00.000Z", id],
    );
  }
  return db;
}

function run(
  db: Db,
  work: Effect.Effect<
    void,
    unknown,
    DbService | RepoCloneService | GitHubAccounts | ExternalIntegrations
  >,
) {
  const log: string[] = [];
  const clones = Layer.succeed(RepoCloneService, {
    deleteClone: (repoId: string) =>
      Effect.sync(() => {
        // The row must still exist when its clone goes: the clone path lives on it.
        const row = db
          .select()
          .from(repositories)
          .all()
          .find((r) => r.id === repoId);
        log.push(`clone ${repoId}${row ? "" : " (row already gone)"}`);
      }),
  } as unknown as RepoCloneService["Service"]);
  const accounts = Layer.succeed(GitHubAccounts, {
    accountsOf: (_userId: string, host?: string) =>
      Effect.succeed(
        host === undefined
          ? ["acc-dotcom", "acc-ghe"]
          : host === "github.com"
            ? ["acc-dotcom"]
            : ["acc-ghe"],
      ),
    disconnect: (_userId: string, host: string) =>
      Effect.sync(() => {
        log.push(`disconnect ${host}`);
        db.delete(account).run();
      }),
    removeUser: (userId: string) => Effect.sync(() => void log.push(`remove ${userId}`)),
  } as unknown as GitHubAccounts["Service"]);
  const integrations = Layer.succeed(ExternalIntegrations, {
    uninstallAccount: (accountId: string) =>
      Effect.sync(() => void log.push(`uninstall ${accountId}`)),
  } as unknown as ExternalIntegrations["Service"]);
  return Effect.runPromise(
    work.pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(DbService, { db }), clones, accounts, integrations),
      ),
    ) as Effect.Effect<void>,
  ).then(() => log);
}

const repoIds = (db: Db) =>
  db
    .select({ id: repositories.id })
    .from(repositories)
    .all()
    .map((r) => r.id);

describe("forget", () => {
  it("removes a repository's clone before its row", async () => {
    const db = seededDb();
    expect(await run(db, forgetRepositories(["repo-acc-ghe"]))).toEqual(["clone repo-acc-ghe"]);
    expect(repoIds(db)).toEqual(["repo-acc-dotcom"]);
  });

  it("removes a disconnected account's agent installs and clones, and only those", async () => {
    const db = seededDb();
    expect(await run(db, forgetAccount("user-1", "ghe.example.com"))).toEqual([
      "uninstall acc-ghe",
      "clone repo-acc-ghe",
      "disconnect ghe.example.com",
    ]);
  });

  it("removes every account's agent installs and clones before removing the user", async () => {
    const db = seededDb();
    expect(await run(db, forgetUser("user-1"))).toEqual([
      "uninstall acc-dotcom",
      "uninstall acc-ghe",
      "clone repo-acc-dotcom",
      "clone repo-acc-ghe",
      "remove user-1",
    ]);
    expect(repoIds(db)).toEqual([]);
  });
});
