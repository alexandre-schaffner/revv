import { describe, expect, it } from "bun:test";
import type { RecapStreamEvent, ServerEventMessage } from "@revv/shared";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../../db/index";
import { account, repositories, user } from "../../db/schema";
import { DbService } from "../Db";
import { DiffCacheService } from "../DiffCache";
import { GitHubGateway } from "../github/gateway";
import { PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import { PullRequestService } from "../PullRequest";
import { Realtime } from "../Realtime";
import { SettingsService } from "../Settings";
import { ProjectRecapServiceLive } from "./ProjectRecap";
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
function recapJobs(db: Db) {
  const broadcasts: ServerEventMessage[] = [];
  const unused = {} as never;
  const realtime = Layer.succeed(Realtime, {
    toAccount: () => Effect.void,
    toRepo: (_repoId, msg) => Effect.sync(() => void broadcasts.push(msg)),
    toPr: () => Effect.void,
    toAll: () => Effect.void,
  });
  const dbLayer = Layer.succeed(DbService, { db });
  const layer = ProjectRecapJobsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        dbLayer,
        realtime,
        ProjectRecapServiceLive.pipe(Layer.provide(Layer.merge(dbLayer, realtime))),
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
