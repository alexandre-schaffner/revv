import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db";
import { account, pullRequests, repositories, user } from "../db/schema";
import { DbService } from "./Db";
import { resolveReviewModeForPr } from "./review-mode";

const PR_ID = "repo-1:7";

/**
 * Seed the identity chain a review mode is derived from: PR → repository →
 * account → user. `userLogin: null` models an identity that hasn't been
 * backfilled yet, which is the state the resolver must report as *unresolved*
 * rather than as a reviewer verdict.
 */
function seedIdentity(params: {
  readonly authorLogin: string;
  readonly userLogin: string | null;
}): Db {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(user)
    .values({
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      githubLogin: params.userLogin,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(account)
    .values({
      id: "account-1",
      accountId: "1",
      providerId: "github:github.com",
      userId: "user-1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(repositories)
    .values({
      id: "repo-1",
      owner: "acme",
      name: "widgets",
      fullName: "acme/widgets",
      addedAt: now.toISOString(),
      accountId: "account-1",
    })
    .run();
  db.insert(pullRequests)
    .values({
      id: PR_ID,
      externalId: 7,
      repositoryId: "repo-1",
      title: "Add widgets",
      authorLogin: params.authorLogin,
      sourceBranch: "feat/widgets",
      targetBranch: "main",
      url: "https://github.com/acme/widgets/pull/7",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      fetchedAt: now.toISOString(),
    })
    .run();
  return db;
}

function runWithDb<A>(db: Db, effect: Effect.Effect<A, never, DbService>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(DbService, { db }))));
}

const resolve = (db: Db, prId = PR_ID) => runWithDb(db, resolveReviewModeForPr(prId));

describe("resolveReviewModeForPr", () => {
  it("reports author for a PR the signed-in user wrote", async () => {
    const db = seedIdentity({ authorLogin: "alex", userLogin: "alex" });
    expect(await resolve(db)).toEqual({ mode: "author", resolved: true });
  });

  it("reports reviewer for someone else's PR", async () => {
    const db = seedIdentity({ authorLogin: "picodes", userLogin: "alex" });
    expect(await resolve(db)).toEqual({ mode: "reviewer", resolved: true });
  });

  // GitHub logins are case-insensitive, and the casing we hold for the viewer
  // comes from a different endpoint than the casing on the PR. Answering
  // "reviewer" on a case mismatch would route the sync into a session the UI
  // never loads.
  it("matches logins case-insensitively", async () => {
    const db = seedIdentity({ authorLogin: "Alex", userLogin: "alex" });
    expect(await resolve(db)).toEqual({ mode: "author", resolved: true });
  });

  // The distinction the callers act on: "we don't know" must not be readable
  // as a reviewer verdict, or the thread repair runs on a guess.
  it("reports unresolved — not reviewer — when no login is known", async () => {
    const db = seedIdentity({ authorLogin: "alex", userLogin: null });
    expect(await resolve(db)).toEqual({ mode: "reviewer", resolved: false });
  });

  it("reports unresolved for an unknown PR", async () => {
    const db = seedIdentity({ authorLogin: "alex", userLogin: "alex" });
    expect(await resolve(db, "nope")).toEqual({ mode: "reviewer", resolved: false });
  });

  // Regression: the resolver used to read `db.select(...).from(user).limit(1)`
  // with no WHERE, so a second identity could win arbitrarily. It now walks the
  // PR's own repository to the account that owns it to that account's user.
  it("resolves against the PR's owning account, not an arbitrary user row", async () => {
    const db = seedIdentity({ authorLogin: "alex", userLogin: "alex" });
    const now = new Date();
    db.insert(user)
      .values({
        id: "user-2",
        name: "Other User",
        email: "other@example.com",
        githubLogin: "someone-else",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(await resolve(db)).toEqual({ mode: "author", resolved: true });
  });
});
