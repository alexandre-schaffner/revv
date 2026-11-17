import { describe, expect, it } from "bun:test";
import type { RecapSourceScope } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { createDb, type Db } from "../db";
import { account, recapThemeSummaries, repositories, user } from "../db/schema";
import { DbService } from "./Db";
import { ProjectRecapService, ProjectRecapServiceLive } from "./recaps/ProjectRecap";

function seed(): Db {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(user)
    .values({ id: "user", name: "User", email: "test@example.com", createdAt: now, updatedAt: now })
    .run();
  for (const id of ["account", "other-account"])
    db.insert(account)
      .values({
        id,
        accountId: id,
        providerId: "github:github.com",
        userId: "user",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  for (const [id, accountId] of [
    ["repo", "account"],
    ["second", "account"],
    ["other", "other-account"],
  ]) {
    if (!id || !accountId) continue;
    db.insert(repositories)
      .values({
        id,
        owner: "acme",
        name: id,
        fullName: `acme/${id}`,
        accountId,
        addedAt: now.toISOString(),
      })
      .run();
  }
  return db;
}
function run<A, E>(
  db: Db,
  effect: Effect.Effect<A, E, ProjectRecapService | DbService>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(ProjectRecapServiceLive), Effect.provideService(DbService, { db })),
  );
}
const scope: RecapSourceScope = {
  key: '["account","all"]',
  kind: "all",
  label: "Everything",
  accountId: "account",
  repositoryIds: ["repo", "second"],
};
const boundaries = {
  period: "weekly" as const,
  periodStart: "2026-10-19T00:00:00.000Z",
  periodEnd: "2026-10-26T00:00:00.000Z",
};

describe("recap scope journal", () => {
  it("preserves account history and supporting work after all source repositories are removed", async () => {
    const db = seed();
    await run(
      db,
      Effect.gen(function* () {
        const service = yield* ProjectRecapService;
        const recap = yield* service.createPartial({
          repositoryId: "repo",
          sourceScope: scope,
          ...boundaries,
        });
        db.insert(recapThemeSummaries)
          .values({ id: "topic", recapId: recap.id, theme: "delivery", summary: "Shipped" })
          .run();
        db.delete(repositories).where(eq(repositories.accountId, "account")).run();
        const persisted = yield* service.getById(recap.id, "account");
        expect(persisted.themeSummaries[0]?.summary).toBe("Shipped");
        expect(
          (yield* service.listForRepo("", { scopeKey: scope.key })).recaps.map((r) => r.id),
        ).toEqual([recap.id]);
        db.delete(account).where(eq(account.id, "account")).run();
        expect((yield* service.getById(recap.id).pipe(Effect.flip))._tag).toBe(
          "RecapNotFoundError",
        );
      }),
    );
    db.$client.close();
  });
  it("denies another account access before returning recap content", async () => {
    const db = seed();
    await run(
      db,
      Effect.gen(function* () {
        const service = yield* ProjectRecapService;
        const recap = yield* service.createPartial({
          repositoryId: "repo",
          sourceScope: scope,
          ...boundaries,
        });
        const denied = yield* service.getById(recap.id, "other-account").pipe(Effect.flip);
        expect(denied._tag).toBe("RecapNotFoundError");
        expect((yield* service.getById(recap.id, "account")).id).toBe(recap.id);
      }),
    );
  });

  it("keeps repository, Everything, team, and other-account history distinct", async () => {
    const db = seed();
    await run(
      db,
      Effect.gen(function* () {
        const service = yield* ProjectRecapService;
        const repo = yield* service.createPartial({ repositoryId: "repo", ...boundaries });
        const all = yield* service.createPartial({
          repositoryId: "repo",
          sourceScope: scope,
          ...boundaries,
        });
        const teamScope: RecapSourceScope = {
          ...scope,
          key: '["account","team","acme","rnd"]',
          kind: "team",
          label: "R&D",
          org: "acme",
          teamSlug: "rnd",
          memberLogins: ["alex"],
        };
        const team = yield* service.createPartial({
          repositoryId: "repo",
          sourceScope: teamScope,
          ...boundaries,
        });
        const otherScope: RecapSourceScope = {
          ...scope,
          key: '["other-account","all"]',
          accountId: "other-account",
          repositoryIds: ["other"],
        };
        yield* service.createPartial({
          repositoryId: "other",
          sourceScope: otherScope,
          ...boundaries,
        });
        expect((yield* service.listForRepo("repo", {})).recaps.map((r) => r.id)).toEqual([repo.id]);
        // Scope identity survives a different first/anchor repository.
        expect(
          (yield* service.listForRepo("second", { scopeKey: scope.key })).recaps.map((r) => r.id),
        ).toEqual([all.id]);
        expect(
          (yield* service.findActiveForPeriod(
            "second",
            "weekly",
            boundaries.periodStart,
            teamScope.key,
          ))?.id,
        ).toBe(team.id);
        expect(
          (yield* service.listGenerating()).find((r) => r.id === team.id)?.sourceScope,
        ).toEqual(teamScope);
      }),
    );
  });
  it("persists changed source membership on rerun so crash recovery uses the same scope", async () => {
    const db = seed();
    await run(
      db,
      Effect.gen(function* () {
        const service = yield* ProjectRecapService;
        const recap = yield* service.createPartial({
          repositoryId: "repo",
          sourceScope: scope,
          ...boundaries,
        });
        const updated = { ...scope, repositoryIds: ["second"] };
        yield* service.resetForRerun(recap.id, { sourceScope: updated });
        expect((yield* service.getById(recap.id)).sourceScope).toEqual(updated);
        expect((yield* service.getById(recap.id)).sourceScope).toEqual(updated);
      }),
    );
  });
  it("returns prior explanations only from earlier periods of the same scope", async () => {
    const db = seed();
    await run(
      db,
      Effect.gen(function* () {
        const service = yield* ProjectRecapService;
        const prior = yield* service.createPartial({
          repositoryId: "repo",
          sourceScope: scope,
          ...boundaries,
        });
        db.insert(recapThemeSummaries)
          .values({
            id: "topic",
            recapId: prior.id,
            theme: "distribution",
            summary: "Batching changed.",
            context: "Rewards reach users.",
            approach: "Signed batches.",
            currentState: "Under review.",
          })
          .run();
        yield* service.finish(prior.id, "complete");
        const later = yield* service.createPartial({
          repositoryId: "repo",
          sourceScope: scope,
          ...boundaries,
          periodStart: "2026-10-26T00:00:00.000Z",
          periodEnd: "2026-11-02T00:00:00.000Z",
        });
        yield* service.finish(later.id, "complete");
        const context = yield* service.getLatestForRepo("second", {
          scopeKey: scope.key,
          beforePeriodStart: "2026-10-26T00:00:00.000Z",
        });
        expect(context.map((r) => r.id)).toEqual([prior.id]);
        expect(context[0]?.themeSummaries[0]?.approach).toBe("Signed batches.");
      }),
    );
  });
});
