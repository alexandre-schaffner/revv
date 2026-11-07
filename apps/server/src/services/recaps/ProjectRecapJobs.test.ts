import { describe, expect, it } from "bun:test";
import type { RecapStreamEvent, ServerEventMessage } from "@revv/shared";
import { Effect, Exit, Layer } from "effect";
import { createDb, type Db } from "../../db/index";
import { account, projectRecaps, repositories, user } from "../../db/schema";
import { DbError } from "../../domain/errors";
import { DbService } from "../Db";
import { DiffCacheService } from "../DiffCache";
import { GitHubGateway } from "../github/gateway";
import { PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import { PullRequestService } from "../PullRequest";
import { Realtime } from "../Realtime";
import { SettingsService } from "../Settings";
import { ProjectRecapService, ProjectRecapServiceLive } from "./ProjectRecap";
import { ProjectRecapJobs, ProjectRecapJobsLive } from "./ProjectRecapJobs";

const REPO_ID = "repo-1";

function seed(db: Db): void {
  const now = new Date();
  db.insert(user)
    .values({ id: "user-1", name: "T", email: "t@example.com", createdAt: now, updatedAt: now })
    .run();
  db.insert(account)
    .values({
      id: "acc-1",
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
      accountId: "acc-1",
    })
    .run();
}

/** The recap orchestrator over a real journal; a run never gets past reading its repository. */
function recapJobs(db: Db, patch: Partial<ProjectRecapService["Service"]> = {}) {
  const broadcasts: ServerEventMessage[] = [];
  const unused = {} as never;
  const realtime = Layer.succeed(Realtime, {
    toAccount: () => Effect.void,
    toRepo: (_repoId, msg) => Effect.sync(() => void broadcasts.push(msg)),
    toPr: () => Effect.void,
  });
  const dbLayer = Layer.succeed(DbService, { db });
  const layer = ProjectRecapJobsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        dbLayer,
        realtime,
        Layer.effect(
          ProjectRecapService,
          Effect.gen(function* () {
            const live = yield* ProjectRecapService;
            return { ...live, ...patch };
          }),
        ).pipe(
          Layer.provide(
            ProjectRecapServiceLive.pipe(Layer.provide(Layer.merge(dbLayer, realtime))),
          ),
        ),
        Layer.succeed(PrContextService, { getRepo: () => Effect.never } as never),
        Layer.succeed(PullRequestService, unused),
        Layer.succeed(SettingsService, unused),
        Layer.succeed(DiffCacheService, unused),
        Layer.succeed(GitHubGateway, unused),
        Layer.succeed(PrMirror, unused),
      ),
    ),
  );
  return { layer, broadcasts };
}

describe("ProjectRecapJobs rerun", () => {
  it("ends the replaced run's stream with `restarted`, never a false Stop", async () => {
    const db = createDb(":memory:");
    seed(db);
    const { layer, broadcasts } = recapJobs(db);
    const request = { repoId: REPO_ID, period: "daily", intent: "manual" } as const;

    const streamed = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* ProjectRecapJobs;
        const first = yield* jobs.requestRecap(request);
        if (!first) throw new Error("a manual request always gets a row");
        const events: RecapStreamEvent[] = [];
        const sub = yield* jobs.subscribe(first.recapId, (e) => void events.push(e));
        if (!sub.found) throw new Error("the first run should be live");
        sub.flush();

        const second = yield* jobs.requestRecap(request);
        expect(second?.recapId).toBe(first.recapId);
        yield* jobs.cancel(first.recapId);
        return events;
      }).pipe(Effect.provide(layer)),
    );

    expect(streamed.map((e) => e.type)).toEqual(["restarted"]);
    const statuses = broadcasts.flatMap((m) =>
      m.type === "recap:status-changed" ? [m.data.status] : [],
    );
    // Only the final cancel stops anything.
    expect(statuses).toEqual(["stopped"]);
  });
});

describe("ProjectRecapJobs request", () => {
  // One active recap per window: a DB error is not "the window has none".
  it("fails, rather than opening a second recap, when the window's recap can't be read", async () => {
    const db = createDb(":memory:");
    seed(db);
    const { layer } = recapJobs(db, {
      findActiveForPeriod: () => Effect.fail(new DbError({ message: "disk I/O error" })),
    });

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ProjectRecapJobs, (jobs) =>
        jobs.requestRecap({ repoId: REPO_ID, period: "daily", intent: "manual" }),
      ).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(db.select().from(projectRecaps).all()).toHaveLength(0);
  });
});

describe("ProjectRecapJobs attach", () => {
  // The stream reads a row `generating`, then attaches: a run that settled in
  // between must not get a second run, a spent attempt or a false error.
  it("leaves a recap whose run already finished alone", async () => {
    const db = createDb(":memory:");
    seed(db);
    db.insert(projectRecaps)
      .values({
        id: "recap-1",
        repositoryId: REPO_ID,
        period: "daily",
        periodStart: "2026-11-01T00:00:00.000Z",
        periodEnd: "2026-11-02T00:00:00.000Z",
        status: "complete",
        generatedAt: "2026-11-01T00:00:00.000Z",
      })
      .run();
    const { layer, broadcasts } = recapJobs(db);

    await Effect.runPromise(
      Effect.flatMap(ProjectRecapJobs, (jobs) => jobs.attach("recap-1")).pipe(
        Effect.provide(layer),
      ),
    );

    expect(
      db
        .select({ status: projectRecaps.status, attempts: projectRecaps.resumeAttempts })
        .from(projectRecaps)
        .all(),
    ).toEqual([{ status: "complete", attempts: 0 }]);
    expect(broadcasts).toEqual([]);
  });
});
