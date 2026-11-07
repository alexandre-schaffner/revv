// The one kernel every durable agent pipeline (walkthrough, project recap,
// stack brief) runs on. The journal row is the job (invariant 1); what lives
// here is the reconstructible part: which runs are live, the concurrency
// budget, each run's abort controller, liveness beacon and MCP bearer token.
//
// The kernel owns the run's lifecycle decisions, so each pipeline makes them
// the same way:
//   • A run ends one of four ways. The user stopped it → `stopped`. Something
//     superseded it → nothing (whoever superseded it owns the row). It was
//     interrupted with no one asking (shutdown, kill) → left `generating` for
//     resume. Otherwise the body's verdict stands, and a body that hands the
//     verdict to the journal completes exactly when the pipeline's completion
//     check passes.
//   • Resume (on boot, the user's, or a request finding a row whose run died)
//     is one budgeted policy, `resumeDecision`: a row no longer `generating`
//     is left alone; a journal that already passes the completion check is
//     completed without a rerun; otherwise the attempt is counted first, and a
//     row over the budget fails (invariant 9). An attempt that can't be
//     counted isn't run. It runs under the pipeline's own lock on the row
//     (`exclusive`), so it can't race the pipeline's other decisions about it.
//   • The pipeline's `settle` writes the terminal status — only from
//     `generating` — and announces it after the commit (invariant 8).

import { Cause, Effect, Exit, Fiber, Ref, type Scope, Semaphore } from "effect";
import { type ActivityBeacon, JOB_TURN, makeActivityBeacon } from "../../ai/acp/run-turn";
import type { DbError } from "../../domain/errors";
import { debug, logError } from "../../logger";
import { makeStartJobMutex } from "../job-mutex";
import { makeSessionTokenStore } from "../session-token-store";

/** Resume-on-boot attempts a row gets before it fails (invariant 9). */
export const MAX_RESUME_ATTEMPTS = 3;

export type StopReason = "user" | "superseded";

/** One live run of a job. Everything on it dies with the run. */
export interface AgentRun<C> {
  readonly id: string;
  /** Bearer for the pipeline's MCP route; resolves to this run until it ends. */
  readonly token: string;
  readonly abort: AbortController;
  /** Rearmed by every MCP call the token authenticates, and by the agent's own updates. */
  readonly activity: ActivityBeacon;
  /** Why the run is being stopped, once someone asked. */
  readonly stopReason: () => StopReason | null;
  /** The pipeline's per-run state. */
  readonly context: C;
}

export type RunEnd<F> =
  /** The agent's work is over: complete if the journal passes the completion check, else `failure`. */
  | { readonly kind: "journal"; readonly failure: F }
  | { readonly kind: "complete" }
  | { readonly kind: "failed"; readonly failure: F };

export type RunOutcome<F> =
  | { readonly kind: "complete" }
  | { readonly kind: "failed"; readonly failure: F }
  | { readonly kind: "stopped" };

export interface AgentJobSpec<C, F> {
  /** Log scope and span prefix. */
  readonly name: string;
  readonly concurrency: number;
  /** Agent turns one run may take; its MCP token must outlive all of them. */
  readonly turnsPerRun: number;
  readonly journal: {
    /** Ids of rows still `generating`. */
    readonly generating: Effect.Effect<ReadonlyArray<string>, DbError>;
    /** Whether row `id` is still `generating`; false for a row that is gone. */
    readonly isGenerating: (id: string) => Effect.Effect<boolean, DbError>;
    /** Returns the new count. */
    readonly bumpResumeAttempts: (id: string) => Effect.Effect<number, DbError>;
    /** Why the row isn't finished yet, or null when its journal holds a finished result. */
    readonly completionBlocker: (id: string) => Effect.Effect<string | null, DbError>;
  };
  /**
   * Write the terminal status, only if the row is still `generating`, and
   * announce it after the commit. `run` is null when no run is live (resume
   * decisions, a Stop on a row whose run died).
   */
  readonly settle: (
    id: string,
    outcome: RunOutcome<F>,
    run: AgentRun<C> | null,
  ) => Effect.Effect<void, DbError>;
  /** The failure recorded when a run's body fails outright. */
  readonly crashed: (cause: Cause.Cause<unknown>) => F;
  /** The failure recorded when a row has crashed more often than {@link MAX_RESUME_ATTEMPTS}. */
  readonly resumeExhausted: F;
  /**
   * Start a run of `id` from its journal row, once the resume decision said
   * to. Called under {@link exclusive}.
   */
  readonly relaunch: (id: string) => Effect.Effect<unknown, unknown>;
  /**
   * Run `effect` under the lock the pipeline takes for every decision about
   * row `id`. Defaults to a lock per row.
   */
  readonly exclusive?: <A, E>(
    id: string,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | DbError>;
}

/**
 * What a resume of a row whose run isn't live decided: it was live after all,
 * it had already settled (or was deleted), its journal passed and it
 * completed, it was over its budget and failed, or it runs again.
 */
export type ResumeDecision = "live" | "gone" | "completed" | "exhausted" | "run";

export interface LaunchInput<C, F, E> {
  readonly id: string;
  readonly context: (run: Omit<AgentRun<never>, "context">) => C;
  /** Waits for the run's inputs (a clone) without holding a concurrency slot. */
  readonly queue?: (run: AgentRun<C>) => Effect.Effect<RunEnd<F> | null, E>;
  readonly body: (run: AgentRun<C>) => Effect.Effect<RunEnd<F>, E>;
  /** Spans, log annotations and the like, wrapped around the whole run. */
  readonly instrument?: (run: AgentRun<C>, effect: Effect.Effect<void>) => Effect.Effect<void>;
}

export interface AgentJobs<C, F> {
  /** Start a run of `id`, or return the one already live. */
  readonly launch: <E>(
    input: LaunchInput<C, F, E>,
  ) => Effect.Effect<{ readonly run: AgentRun<C>; readonly reused: boolean }>;
  readonly running: (id: string) => Effect.Effect<AgentRun<C> | null>;
  readonly runs: Effect.Effect<ReadonlyArray<AgentRun<C>>>;
  /** Stop a run and wait until it has ended. A user Stop on a row with no live run settles it as stopped. */
  readonly stop: (id: string, reason: StopReason) => Effect.Effect<void>;
  /** Run `id` again if its run died, under the resume budget. A no-op while it is live. */
  readonly resume: (id: string) => Effect.Effect<void>;
  /**
   * The resume policy alone, for a pipeline that already holds its lock on
   * `id` and relaunches the row itself on `run`. Settles `completed` and
   * `exhausted` rows.
   */
  readonly resumeDecision: (id: string) => Effect.Effect<ResumeDecision, DbError>;
  readonly resumePending: Effect.Effect<void>;
  readonly resolveToken: (token: string) => Effect.Effect<AgentRun<C> | null>;
}

interface Live<C> {
  readonly run: AgentRun<C>;
  stopReason: StopReason | null;
  fiber: Fiber.Fiber<void> | null;
}

export const makeAgentJobs = <C, F>(
  spec: AgentJobSpec<C, F>,
): Effect.Effect<AgentJobs<C, F>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const registry = yield* Ref.make(new Map<string, Live<C>>());
    const semaphore = yield* Semaphore.make(spec.concurrency);
    const resumeMutex = yield* makeStartJobMutex();
    const tokens = yield* makeSessionTokenStore<string>(
      JOB_TURN.ceilingMs * spec.turnsPerRun + 5 * 60_000,
      (id) => Effect.map(Ref.get(registry), (map) => map.has(id)),
    );

    const settle = (id: string, outcome: RunOutcome<F>, run: AgentRun<C> | null) =>
      spec.settle(id, outcome, run).pipe(
        Effect.catchTag("DbError", (err) =>
          Effect.sync(() =>
            // The row stays `generating`; the next resume decides again.
            logError(spec.name, `settling ${id} as ${outcome.kind} failed:`, err.message),
          ),
        ),
      );

    const conclude = (live: Live<C>, exit: Exit.Exit<RunEnd<F>, unknown>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { run } = live;
        if (live.stopReason === "user") return yield* settle(run.id, { kind: "stopped" }, run);
        if (live.stopReason === "superseded") return;
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) {
            debug(spec.name, `${run.id} interrupted — left for resume`);
            return;
          }
          logError(spec.name, `${run.id} failed:`, Cause.pretty(exit.cause));
          return yield* settle(run.id, { kind: "failed", failure: spec.crashed(exit.cause) }, run);
        }
        const end = exit.value;
        if (end.kind !== "journal") return yield* settle(run.id, end, run);
        const blocker = yield* spec.journal
          .completionBlocker(run.id)
          .pipe(
            Effect.catchTag("DbError", (err) =>
              Effect.succeed(`completion check failed: ${err.message}`),
            ),
          );
        yield* settle(
          run.id,
          blocker === null ? { kind: "complete" } : { kind: "failed", failure: end.failure },
          run,
        );
      });

    const release = (live: Live<C>) =>
      Effect.gen(function* () {
        yield* Ref.update(registry, (map) => {
          if (map.get(live.run.id) !== live) return map;
          const next = new Map(map);
          next.delete(live.run.id);
          return next;
        });
        yield* tokens.clear(live.run.token);
        if (!live.run.abort.signal.aborted) live.run.abort.abort(new Error("Run ended"));
      });

    const launch = <E>(
      input: LaunchInput<C, F, E>,
    ): Effect.Effect<{ readonly run: AgentRun<C>; readonly reused: boolean }> =>
      Effect.gen(function* () {
        const token = yield* tokens.issue(input.id);
        const abort = new AbortController();
        const activity = makeActivityBeacon();
        let live: Live<C> | null = null;
        const stopReason = () => live?.stopReason ?? null;
        const handles = { id: input.id, token, abort, activity, stopReason };
        const run: AgentRun<C> = { ...handles, context: input.context(handles) };
        const created: Live<C> = { run, stopReason: null, fiber: null };
        live = created;

        const existing = yield* Ref.modify(registry, (map) => {
          const current = map.get(input.id);
          if (current && current.stopReason === null) return [current, map] as const;
          return [null, new Map(map).set(input.id, created)] as const;
        });
        if (existing) {
          yield* tokens.clear(token);
          return { run: existing.run, reused: true };
        }

        const work = Effect.gen(function* () {
          const queued = input.queue ? yield* input.queue(run) : null;
          if (queued !== null) return queued;
          return yield* semaphore.withPermits(1)(input.body(run));
        });
        const program = work.pipe(
          Effect.onExit((exit) => conclude(created, exit)),
          Effect.ensuring(release(created)),
          Effect.asVoid,
          Effect.catchCause(() => Effect.void),
        );
        // Started at once, so a Stop right after launch finds the exit
        // handler in place rather than interrupting a fiber that never ran.
        created.fiber = yield* Effect.forkIn(
          input.instrument ? input.instrument(run, program) : program,
          scope,
          { startImmediately: true },
        );
        return { run, reused: false };
      });

    const running = (id: string) =>
      Effect.map(Ref.get(registry), (map) => map.get(id)?.run ?? null);

    const stop = (id: string, reason: StopReason): Effect.Effect<void> =>
      Effect.gen(function* () {
        const live = (yield* Ref.get(registry)).get(id);
        if (!live) {
          if (reason === "user") yield* settle(id, { kind: "stopped" }, null);
          return;
        }
        live.stopReason ??= reason;
        if (!live.run.abort.signal.aborted) live.run.abort.abort(new Error(`Run ${reason}`));
        if (live.fiber) yield* Fiber.interrupt(live.fiber);
      });

    const exclusive =
      spec.exclusive ??
      (<A, E>(id: string, effect: Effect.Effect<A, E>) =>
        Effect.flatMap(resumeMutex.acquire(id), (mutex) => mutex.withPermits(1)(effect)));

    const resumeDecision = (id: string): Effect.Effect<ResumeDecision, DbError> =>
      Effect.gen(function* () {
        // Live first: a run settles its row before it leaves the registry,
        // so a row read as generating after this has no run left to settle it.
        if ((yield* Ref.get(registry)).has(id)) return "live";
        if (!(yield* spec.journal.isGenerating(id))) return "gone";
        const blocker = yield* spec.journal.completionBlocker(id);
        if (blocker === null) {
          yield* settle(id, { kind: "complete" }, null);
          return "completed";
        }
        const attempts = yield* spec.journal.bumpResumeAttempts(id);
        if (attempts > MAX_RESUME_ATTEMPTS) {
          debug(spec.name, `${id} exceeded ${MAX_RESUME_ATTEMPTS} resume attempts`);
          yield* settle(id, { kind: "failed", failure: spec.resumeExhausted }, null);
          return "exhausted";
        }
        return "run";
      });

    const resume = (id: string): Effect.Effect<void> =>
      exclusive(
        id,
        Effect.gen(function* () {
          if ((yield* resumeDecision(id)) === "run") yield* spec.relaunch(id);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => logError(spec.name, `resume of ${id} failed:`, Cause.pretty(cause))),
        ),
      );

    const resumePending = Effect.gen(function* () {
      const ids = yield* spec.journal.generating;
      debug(spec.name, `resumePending: ${ids.length} row(s)`);
      for (const id of ids) yield* resume(id);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => logError(spec.name, "resumePending failed:", Cause.pretty(cause))),
      ),
      Effect.withSpan(`${spec.name}.resumePending`),
    );

    const resolveToken = (token: string) =>
      Effect.gen(function* () {
        const id = yield* tokens.resolve(token);
        if (id === null) return null;
        const live = (yield* Ref.get(registry)).get(id);
        if (!live || live.run.token !== token) return null;
        live.run.activity.note();
        return live.run;
      });

    return {
      launch,
      running,
      runs: Effect.map(Ref.get(registry), (map) => [...map.values()].map((live) => live.run)),
      stop,
      resume,
      resumeDecision,
      resumePending,
      resolveToken,
    };
  });
