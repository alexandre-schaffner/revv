import { describe, expect, it } from "bun:test";
import { Cause, Deferred, Effect, Fiber, type Scope, Semaphore } from "effect";
import { DbError } from "../../domain/errors";
import {
  type AgentJobs,
  type AgentRun,
  MAX_RESUME_ATTEMPTS,
  makeAgentJobs,
  type RunEnd,
  type RunOutcome,
} from "./agent-jobs";

// An in-memory journal standing in for a pipeline's table: what survives a
// `kill -9` is exactly what is in `rows`.
interface Row {
  status: "generating" | "complete" | "error" | "stopped";
  attempts: number;
  /** The journal holds a finished result. */
  done: boolean;
  failure: string | null;
}

interface Harness {
  readonly rows: Map<string, Row>;
  readonly settled: Array<{ id: string; outcome: RunOutcome<string>; live: boolean }>;
  readonly relaunched: string[];
  readonly jobs: AgentJobs<{ note: string }, string>;
  failBump: boolean;
}

const makeHarness = (
  rows: Record<string, Partial<Row>> = {},
  exclusive?: <A, E>(id: string, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const harness = {
      rows: new Map(
        Object.entries(rows).map(([id, row]) => [
          id,
          { status: "generating", attempts: 0, done: false, failure: null, ...row } as Row,
        ]),
      ),
      settled: [],
      relaunched: [],
      failBump: false,
    } as unknown as Harness;
    const jobs = yield* makeAgentJobs<{ note: string }, string>({
      name: "test-jobs",
      concurrency: 1,
      turnsPerRun: 1,
      journal: {
        generating: Effect.sync(() =>
          [...harness.rows].filter(([, row]) => row.status === "generating").map(([id]) => id),
        ),
        isGenerating: (id) => Effect.sync(() => harness.rows.get(id)?.status === "generating"),
        bumpResumeAttempts: (id) =>
          harness.failBump
            ? Effect.fail(new DbError({ message: "disk full" }))
            : Effect.sync(() => {
                const row = harness.rows.get(id);
                if (!row) throw new Error(`no row ${id}`);
                row.attempts += 1;
                return row.attempts;
              }),
        completionBlocker: (id) =>
          Effect.sync(() => (harness.rows.get(id)?.done ? null : "not finished")),
      },
      settle: (id, outcome, run) =>
        Effect.sync(() => {
          harness.settled.push({ id, outcome, live: run !== null });
          const row = harness.rows.get(id);
          if (row?.status !== "generating") return;
          row.status =
            outcome.kind === "complete"
              ? "complete"
              : outcome.kind === "stopped"
                ? "stopped"
                : "error";
          row.failure = outcome.kind === "failed" ? outcome.failure : null;
        }),
      crashed: (cause) => `crashed: ${Cause.pretty(cause).split("\n")[0]}`,
      resumeExhausted: "too many resumes",
      relaunch: (id) => Effect.sync(() => void harness.relaunched.push(id)),
      ...(exclusive ? { exclusive } : {}),
    });
    (harness as { jobs: AgentJobs<{ note: string }, string> }).jobs = jobs;
    return harness;
  });

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

const launch = (
  harness: Harness,
  id: string,
  body: (run: AgentRun<{ note: string }>) => Effect.Effect<RunEnd<string>, unknown>,
) => harness.jobs.launch({ id, context: () => ({ note: id }), body });

const ended = (harness: Harness, id: string) =>
  Effect.gen(function* () {
    while ((yield* harness.jobs.running(id)) !== null) yield* Effect.sleep(1);
  });

describe("agent job kernel", () => {
  it("completes a run whose body hands the verdict to a finished journal", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {} });
        yield* launch(h, "a", () =>
          Effect.sync(() => {
            const row = h.rows.get("a");
            if (row) row.done = true;
            return { kind: "journal", failure: "agent stopped early" } as const;
          }),
        );
        yield* ended(h, "a");
        expect(h.rows.get("a")?.status).toBe("complete");
      }),
    ));

  it("fails a run whose journal isn't finished with the body's failure", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {} });
        yield* launch(h, "a", () =>
          Effect.succeed({ kind: "journal", failure: "agent stopped early" } as const),
        );
        yield* ended(h, "a");
        expect(h.rows.get("a")).toMatchObject({ status: "error", failure: "agent stopped early" });
      }),
    ));

  it("returns the live run instead of launching a second one", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {} });
        const gate = yield* Deferred.make<void>();
        const first = yield* launch(h, "a", () =>
          Effect.as(Deferred.await(gate), { kind: "complete" } as const),
        );
        const second = yield* launch(h, "a", () => Effect.succeed({ kind: "complete" } as const));
        expect(first.reused).toBe(false);
        expect(second.reused).toBe(true);
        expect(second.run.token).toBe(first.run.token);
        yield* Deferred.succeed(gate, undefined);
        yield* ended(h, "a");
      }),
    ));

  it("settles a user Stop as stopped, and leaves a superseded row to its superseder", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {}, b: {} });
        yield* launch(h, "a", () => Effect.never);
        yield* launch(h, "b", () => Effect.never);
        yield* h.jobs.stop("a", "user");
        yield* h.jobs.stop("b", "superseded");
        expect(h.rows.get("a")?.status).toBe("stopped");
        expect(h.rows.get("b")?.status).toBe("generating");
        expect(yield* h.jobs.running("a")).toBeNull();
      }),
    ));

  it("settles a Stop on a row whose run already died", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {} });
        yield* h.jobs.stop("a", "user");
        expect(h.rows.get("a")?.status).toBe("stopped");
      }),
    ));

  it("settles a Stop with no live run under the pipeline's lock, stopping a run launched meanwhile", () =>
    scoped(
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1);
        const h = yield* makeHarness({ a: {} }, (_id, effect) => lock.withPermits(1)(effect));
        // A rerun holds the lock across its decision and its launch.
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const rerun = yield* Effect.forkChild(
          lock.withPermits(1)(
            Effect.gen(function* () {
              yield* Deferred.succeed(held, undefined);
              yield* Deferred.await(release);
              yield* launch(h, "a", () => Effect.never);
            }),
          ),
        );
        yield* Deferred.await(held);
        const stopping = yield* Effect.forkChild(h.jobs.stop("a", "user"));
        yield* Effect.sleep(5);
        expect(h.rows.get("a")?.status).toBe("generating");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(rerun);
        yield* Fiber.join(stopping);
        expect(h.rows.get("a")?.status).toBe("stopped");
        expect(h.settled).toEqual([{ id: "a", outcome: { kind: "stopped" }, live: true }]);
        expect(yield* h.jobs.running("a")).toBeNull();
      }),
    ));

  it("leaves an unasked-for interrupt (shutdown, kill) for resume", async () => {
    const rows = { a: {} };
    let harness: Harness | null = null;
    await scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(rows);
        harness = h;
        yield* launch(h, "a", () => Effect.never);
        yield* Effect.sleep(5);
      }),
    );
    // Closing the scope interrupted the run, as a shutdown does.
    expect((harness as Harness | null)?.rows.get("a")?.status).toBe("generating");
  });

  it("records a crash of the run's body", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {} });
        yield* launch(h, "a", () => Effect.fail(new Error("worktree gone")));
        yield* ended(h, "a");
        expect(h.rows.get("a")?.status).toBe("error");
        expect(h.rows.get("a")?.failure).toContain("crashed");
      }),
    ));

  it("resolves a token only while its run is live, and notes it as activity", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {} });
        const gate = yield* Deferred.make<void>();
        const { run } = yield* launch(h, "a", () =>
          Effect.as(Deferred.await(gate), { kind: "complete" } as const),
        );
        let noted = 0;
        run.activity.onNote(() => {
          noted += 1;
        });
        expect((yield* h.jobs.resolveToken(run.token))?.context.note).toBe("a");
        expect(noted).toBe(1);
        yield* Deferred.succeed(gate, undefined);
        yield* ended(h, "a");
        expect(yield* h.jobs.resolveToken(run.token)).toBeNull();
      }),
    ));
});

// What a restart does with each row it finds `generating` — the journal is all
// that survived (invariant 1).
describe("agent job kernel: resume from the journal", () => {
  it("completes a row whose journal is already finished, without a rerun", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: { done: true } });
        yield* h.jobs.resumePending;
        expect(h.rows.get("a")?.status).toBe("complete");
        expect(h.relaunched).toEqual([]);
        expect(h.rows.get("a")?.attempts).toBe(0);
      }),
    ));

  it("counts the attempt, then relaunches a row cut off mid-phase", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: { attempts: 1 }, b: { status: "complete" } });
        yield* h.jobs.resumePending;
        expect(h.relaunched).toEqual(["a"]);
        expect(h.rows.get("a")?.attempts).toBe(2);
      }),
    ));

  it("fails a row over the resume budget instead of running it again", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: { attempts: MAX_RESUME_ATTEMPTS } });
        yield* h.jobs.resumePending;
        expect(h.relaunched).toEqual([]);
        expect(h.rows.get("a")).toMatchObject({ status: "error", failure: "too many resumes" });
      }),
    ));

  it("doesn't run an attempt it couldn't count", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {} });
        h.failBump = true;
        yield* h.jobs.resume("a");
        expect(h.relaunched).toEqual([]);
        expect(h.rows.get("a")?.status).toBe("generating");
      }),
    ));

  // A reader that saw the row `generating` just before its run settled it
  // (the recap stream, a brief's ensure) must not run a finished row again.
  it("leaves a row its run already settled alone", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {}, b: { status: "error", failure: "boom" } });
        yield* launch(h, "a", () => Effect.succeed({ kind: "complete" } as const));
        yield* ended(h, "a");

        expect(yield* h.jobs.resumeDecision("a")).toBe("gone");
        yield* h.jobs.resume("b");
        expect(h.relaunched).toEqual([]);
        expect(h.settled.map((s) => s.id)).toEqual(["a"]);
        expect(h.rows.get("a")).toMatchObject({ status: "complete", attempts: 0 });
        expect(h.rows.get("b")).toMatchObject({ status: "error", attempts: 0, failure: "boom" });
      }),
    ));

  it("spends the budget on a read path's resume too, and leaves a live run alone", () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ a: {}, b: {} });
        for (let i = 0; i <= MAX_RESUME_ATTEMPTS; i++) yield* h.jobs.resume("a");
        expect(h.relaunched).toHaveLength(MAX_RESUME_ATTEMPTS);
        expect(h.rows.get("a")?.status).toBe("error");

        yield* launch(h, "b", () => Effect.never);
        yield* h.jobs.resume("b");
        expect(h.rows.get("b")?.attempts).toBe(0);
      }),
    ));
});
