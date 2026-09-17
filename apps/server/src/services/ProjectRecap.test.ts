import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, projectRecaps, repositories, user } from "../db/schema";
import { DbService } from "./Db";
import {
  type ListForRepoParams,
  ProjectRecapService,
  ProjectRecapServiceLive,
} from "./ProjectRecap";

const ACCOUNT_ID = "acc-1";
const REPO_ID = "repo-1";

/**
 * Daily rows across June plus two weekly rows. `generatedAt` deliberately runs
 * *opposite* to `periodStart` so a test that accidentally filters on the wrong
 * axis produces visibly wrong output rather than a coincidence.
 */
function seed(db: Db): void {
  const now = new Date();
  db.insert(user)
    .values({
      id: "user-1",
      name: "Test",
      email: "test@example.com",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(account)
    .values({
      id: ACCOUNT_ID,
      accountId: "gh-1",
      providerId: "github:github.com",
      userId: "user-1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(repositories)
    .values({
      id: REPO_ID,
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      addedAt: now.toISOString(),
      accountId: ACCOUNT_ID,
    })
    .run();

  const dailyStarts = ["2026-05-31", "2026-06-01", "2026-06-15", "2026-06-30", "2026-07-01"];
  db.insert(projectRecaps)
    .values([
      ...dailyStarts.map((day, i) => ({
        id: `daily-${day}`,
        repositoryId: REPO_ID,
        period: "daily",
        periodStart: `${day}T00:00:00.000Z`,
        periodEnd: `${day}T23:59:59.999Z`,
        status: "complete",
        // Reverse order: the oldest window has the newest generatedAt.
        generatedAt: `2026-08-${String(10 - i).padStart(2, "0")}T00:00:00.000Z`,
      })),
      {
        id: "weekly-2026-06-01",
        repositoryId: REPO_ID,
        period: "weekly",
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-06-08T00:00:00.000Z",
        status: "complete",
        generatedAt: "2026-08-20T00:00:00.000Z",
      },
      {
        id: "weekly-2026-06-29",
        repositoryId: REPO_ID,
        period: "weekly",
        periodStart: "2026-06-29T00:00:00.000Z",
        periodEnd: "2026-07-06T00:00:00.000Z",
        status: "complete",
        generatedAt: "2026-08-21T00:00:00.000Z",
      },
      {
        id: "daily-superseded",
        repositoryId: REPO_ID,
        period: "daily",
        periodStart: "2026-06-15T00:00:00.000Z",
        periodEnd: "2026-06-15T23:59:59.999Z",
        status: "superseded",
        supersededBy: "daily-2026-06-15",
        generatedAt: "2026-08-01T00:00:00.000Z",
      },
    ])
    .run();
}

function list(db: Db, params: ListForRepoParams) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* ProjectRecapService;
      return yield* svc.listForRepo(REPO_ID, params);
    }).pipe(
      Effect.provide(ProjectRecapServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );
}

function ids(db: Db, params: ListForRepoParams): Promise<string[]> {
  return list(db, params).then((r) => r.recaps.map((x) => x.id).sort());
}

describe("listForRepo from/to range filter", () => {
  it("is identical to today's behaviour when neither bound is given", async () => {
    const db = createDb(":memory:");
    seed(db);
    expect(await ids(db, {})).toEqual([
      "daily-2026-05-31",
      "daily-2026-06-01",
      "daily-2026-06-15",
      "daily-2026-06-30",
      "daily-2026-07-01",
      "weekly-2026-06-01",
      "weekly-2026-06-29",
    ]);
  });

  it("keeps only rows whose window starts inside [from, to)", async () => {
    const db = createDb(":memory:");
    seed(db);
    expect(
      await ids(db, { from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" }),
    ).toEqual([
      "daily-2026-06-01",
      "daily-2026-06-15",
      "daily-2026-06-30",
      "weekly-2026-06-01",
      "weekly-2026-06-29",
    ]);
  });

  it("is inclusive at `from` and exclusive at `to`", async () => {
    const db = createDb(":memory:");
    seed(db);
    // `from` lands exactly on a row's periodStart — that row is in.
    expect(
      await ids(db, { from: "2026-06-30T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" }),
    ).toEqual(["daily-2026-06-30"]);
    // `to` lands exactly on a row's periodStart — that row is out.
    expect(
      await ids(db, { from: "2026-06-30T00:00:00.000Z", to: "2026-06-30T00:00:00.000Z" }),
    ).toEqual([]);
  });

  it("accepts either bound on its own", async () => {
    const db = createDb(":memory:");
    seed(db);
    expect(await ids(db, { from: "2026-07-01T00:00:00.000Z" })).toEqual(["daily-2026-07-01"]);
    expect(await ids(db, { to: "2026-06-01T00:00:00.000Z" })).toEqual(["daily-2026-05-31"]);
  });

  it("bounds periodStart, not generatedAt", async () => {
    const db = createDb(":memory:");
    seed(db);
    // Every row was generated in August; a range over June must still match,
    // and a range over August must match nothing.
    expect(
      (await ids(db, { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" })).length,
    ).toBe(0);
  });

  it("composes with the period filter", async () => {
    const db = createDb(":memory:");
    seed(db);
    expect(
      await ids(db, {
        period: "weekly",
        from: "2026-06-01T00:00:00.000Z",
        to: "2026-07-01T00:00:00.000Z",
      }),
    ).toEqual(["weekly-2026-06-01", "weekly-2026-06-29"]);
  });

  it("composes with includeSuperseded", async () => {
    const db = createDb(":memory:");
    seed(db);
    const range = { from: "2026-06-15T00:00:00.000Z", to: "2026-06-16T00:00:00.000Z" };
    expect(await ids(db, range)).toEqual(["daily-2026-06-15"]);
    expect(await ids(db, { ...range, includeSuperseded: true })).toEqual([
      "daily-2026-06-15",
      "daily-superseded",
    ]);
  });

  it("composes with the generatedAt cursor without either bound leaking into the other", async () => {
    const db = createDb(":memory:");
    seed(db);
    // generatedAt runs opposite to periodStart in the fixture, so a cursor
    // that trims the *newest generations* must trim the *oldest windows*.
    const page = await list(db, {
      period: "daily",
      cursor: "2026-08-09T00:00:00.000Z",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    });
    // `cursor` is strict `<`, so it drops the two newest generations
    // (2026-05-31 and 2026-06-01) and leaves the rest in generatedAt DESC.
    expect(page.recaps.map((r) => r.id)).toEqual([
      "daily-2026-06-15",
      "daily-2026-06-30",
      "daily-2026-07-01",
    ]);
  });

  it("still pages: nextCursor is set when the range holds more than `limit`", async () => {
    const db = createDb(":memory:");
    seed(db);
    const page = await list(db, {
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
      limit: 2,
    });
    expect(page.recaps).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});
