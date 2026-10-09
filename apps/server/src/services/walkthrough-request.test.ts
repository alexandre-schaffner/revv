import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createDb, type Db } from "../db";
import { CloneInProgressError, HeadShaMismatchError } from "../domain/errors";
import { DbService } from "./Db";
import {
  type StartJobError,
  type StartJobParams,
  type StartJobResult,
  WALKTHROUGH_CANCELLED_MESSAGE,
  WalkthroughJobs,
} from "./WalkthroughJobs";
import {
  describeWalkthroughRequestError,
  MAX_RUNS_PER_HEAD,
  MAX_RUNS_PER_PR_PER_HOUR,
  requestWalkthroughAtHead,
} from "./walkthrough-request";

const OLD_HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const databases: Db[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

function seededDb(): Db {
  const db = createDb(":memory:");
  databases.push(db);
  const now = "2026-10-09T12:00:00.000Z";
  db.$client.run(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["user-1", "Author", "author@example.com", 1, Date.now(), Date.now()],
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
      OLD_HEAD,
      now,
      now,
      now,
    ],
  );
  db.$client.run(
    "INSERT INTO review_sessions (id, pull_request_id, started_at, status) VALUES (?, ?, ?, ?)",
    ["session-1", "pr-1", now, "active"],
  );
  return db;
}

let rowCounter = 0;

function insertWalkthrough(
  db: Db,
  headSha: string,
  status: string,
  options: {
    readonly id?: string;
    readonly errorMessage?: string;
    readonly generatedAt?: string;
  } = {},
): string {
  const id = options.id ?? `walkthrough-${++rowCounter}`;
  db.$client.run(
    `INSERT INTO walkthroughs
      (id, review_session_id, pull_request_id, status, last_completed_phase, generated_at, model_used, pr_head_sha, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "session-1",
      "pr-1",
      status,
      "D",
      // Later inserts are newer, as the orchestrator writes them.
      options.generatedAt ?? new Date(Date.now() + rowCounter).toISOString(),
      "test",
      headSha,
      options.errorMessage ?? null,
    ],
  );
  return id;
}

type StartJob = (params: StartJobParams) => Effect.Effect<StartJobResult, StartJobError>;

function request(db: Db, startJob: StartJob) {
  // `requestWalkthroughAtHead` only ever calls `startJob`.
  const jobs = { startJob } as never;
  return requestWalkthroughAtHead({
    prId: "pr-1",
    userId: "user-1",
    headSha: NEW_HEAD,
    generationMode: "incremental",
  }).pipe(Effect.provideService(WalkthroughJobs, jobs), Effect.provideService(DbService, { db }));
}

function recordingStartJob(
  result: StartJobResult = { walkthroughId: "walkthrough-new", reused: false },
) {
  const calls: StartJobParams[] = [];
  const startJob: StartJob = (params) =>
    Effect.sync(() => {
      calls.push(params);
      return result;
    });
  return { calls, startJob };
}

describe("requestWalkthroughAtHead", () => {
  it("returns a completed review of the head without starting a job", async () => {
    const db = seededDb();
    insertWalkthrough(db, NEW_HEAD, "complete", { id: "walkthrough-done" });
    insertWalkthrough(db, NEW_HEAD, "superseded");
    const { calls, startJob } = recordingStartJob();

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome).toEqual({
      kind: "already_complete",
      walkthroughId: "walkthrough-done",
      headSha: NEW_HEAD,
      mode: "reviewer",
    });
    expect(calls).toEqual([]);
  });

  it("starts a job pinned to the pushed head, on the agent's behalf", async () => {
    const db = seededDb();
    insertWalkthrough(db, OLD_HEAD, "complete");
    const { calls, startJob } = recordingStartJob();

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome).toEqual({
      kind: "started",
      walkthroughId: "walkthrough-new",
      headSha: NEW_HEAD,
      mode: "reviewer",
    });
    expect(calls).toEqual([
      {
        prId: "pr-1",
        userId: "user-1",
        trigger: "external_agent",
        mode: "reviewer",
        generationMode: "incremental",
        expectedHeadSha: NEW_HEAD,
      },
    ]);
  });

  it("reports a job already generating the head as joined", async () => {
    const db = seededDb();
    const { startJob } = recordingStartJob({ walkthroughId: "walkthrough-live", reused: true });

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome).toMatchObject({ kind: "joined", walkthroughId: "walkthrough-live" });
  });

  it("starts nothing while GitHub still serves another head", async () => {
    const db = seededDb();
    const startJob: StartJob = () =>
      Effect.fail(new HeadShaMismatchError({ expectedHeadSha: NEW_HEAD, githubHeadSha: OLD_HEAD }));

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome).toEqual({ kind: "head_mismatch", githubHeadSha: OLD_HEAD });
  });

  it("never restarts a run the user stopped", async () => {
    const db = seededDb();
    const stopped = insertWalkthrough(db, NEW_HEAD, "error", {
      errorMessage: WALKTHROUGH_CANCELLED_MESSAGE,
    });
    const { calls, startJob } = recordingStartJob();

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome).toEqual({ kind: "stopped_by_user", walkthroughId: stopped });
    expect(calls).toEqual([]);
  });

  it("retries a run that failed on its own", async () => {
    const db = seededDb();
    insertWalkthrough(db, NEW_HEAD, "error", { errorMessage: "agent crashed" });
    const { calls, startJob } = recordingStartJob();

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome.kind).toBe("started");
    expect(calls).toHaveLength(1);
  });

  it("stops starting runs at a head once its budget is spent", async () => {
    const db = seededDb();
    for (let run = 0; run < MAX_RUNS_PER_HEAD; run++) {
      insertWalkthrough(db, NEW_HEAD, run === 0 ? "error" : "superseded", {
        errorMessage: "agent crashed",
      });
    }
    const { calls, startJob } = recordingStartJob();

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome).toEqual({ kind: "budget_exhausted", scope: "head", runs: MAX_RUNS_PER_HEAD });
    expect(calls).toEqual([]);
  });

  it("stops starting runs on a PR that ran too many in the last hour", async () => {
    const db = seededDb();
    for (let run = 0; run < MAX_RUNS_PER_PR_PER_HOUR; run++) {
      insertWalkthrough(db, String(run).repeat(40), "superseded");
    }
    insertWalkthrough(db, OLD_HEAD, "complete", {
      generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const { calls, startJob } = recordingStartJob();

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome).toEqual({
      kind: "budget_exhausted",
      scope: "pr_hour",
      runs: MAX_RUNS_PER_PR_PER_HOUR,
    });
    expect(calls).toEqual([]);
  });

  it("joins a generating run whatever the budget says", async () => {
    const db = seededDb();
    for (let run = 0; run < MAX_RUNS_PER_HEAD; run++) {
      insertWalkthrough(db, NEW_HEAD, "superseded");
    }
    insertWalkthrough(db, NEW_HEAD, "generating");
    const { calls, startJob } = recordingStartJob({
      walkthroughId: "walkthrough-live",
      reused: true,
    });

    const outcome = await Effect.runPromise(request(db, startJob));

    expect(outcome.kind).toBe("joined");
    expect(calls).toHaveLength(1);
  });

  it("names a failure an agent can act on", async () => {
    const db = seededDb();
    const startJob: StartJob = () => Effect.fail(new CloneInProgressError({ repoId: "repo-1" }));

    // As the MCP route runs it: the runtime's own message for a tagged error
    // without one is "An error has occurred".
    const failure = Effect.runPromise(
      request(db, startJob).pipe(
        Effect.mapError((error) => new Error(describeWalkthroughRequestError(error))),
      ),
    );

    await expect(failure).rejects.toThrow(
      "Revv is still cloning this repository. Retry in a minute.",
    );
  });
});
