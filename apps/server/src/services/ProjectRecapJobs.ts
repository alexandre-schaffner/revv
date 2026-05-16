// ── ProjectRecapJobs ────────────────────────────────────────────────────────
// Durable orchestrator for daily / weekly project recap generation. Mirrors
// the structure of {@link WalkthroughJobs} but radically simpler:
//
//   • Single-phase MCP-routed pipeline (one atomic write per recap).
//   • No worktrees, no continuations, no SSE streaming. Status-only WS
//     broadcasts; the recap UI re-fetches the row when needed.
//   • Per-(repoId, period, periodStart) mutex so concurrent claim paths
//     can't fork duplicate fibers.
//   • Bounded retries via `resume_attempts`. Boot resume re-runs the agent
//     from scratch — recap is single-phase so partial state is just the
//     row at `status='generating'` with empty overview, which is
//     recoverable by re-running.
//
// Per CLAUDE.md invariants #2 and #11: agents never write `status`. This
// service is the sole writer. Content writes go through the recap MCP tool
// handlers in `ai/providers/recap-tools/`.

import type { ProjectRecap, RecapPeriod, RecapSummaryStats } from "@revv/shared";
import { Cause, Context, Effect, Fiber, Layer, Ref } from "effect";
import type { RecapSourceBundle, RecapSourcePr } from "../ai/providers/recap-tools";
import { type RecapError, ValidationError } from "../domain/errors";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { DbService } from "./Db";
import { ProjectRecapService } from "./ProjectRecap";
import { type ArchivedPrWithWalkthrough, PullRequestService } from "./PullRequest";
import { RepositoryService } from "./Repository";
import { runRecapAgent } from "./recap-agent-runner";
import { SettingsService } from "./Settings";
import { WebSocketHub } from "./WebSocketHub";

// ── Constants ────────────────────────────────────────────────────────────────

/** Cap on concurrent recap jobs. Lower than walkthroughs — recap calls are heavier per turn. */
export const MAX_CONCURRENT_RECAP_JOBS = 2;

/** Resume-on-boot retry budget. After this many attempts the row goes to 'error'. */
export const RECAP_MAX_RESUME_ATTEMPTS = 3;

// ── Types ────────────────────────────────────────────────────────────────────

interface ActiveRecapJob {
  readonly recapId: string;
  readonly repoId: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly abortController: AbortController;
  fiber: Fiber.RuntimeFiber<unknown, unknown> | null;
  cancelledByUser: boolean;
  /** Set to true the moment the agent calls `complete_recap` and validation passes. */
  validatedComplete: boolean;
}

export type StartRecapJobTrigger = "scheduler" | "manual" | "resume";

export interface StartRecapJobParams {
  readonly repoId: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly trigger: StartRecapJobTrigger;
  /** Caller-provided id when resuming an existing row. */
  readonly recapId?: string;
}

export type StartRecapJobError = ValidationError | RecapError;

// ── Service tag ──────────────────────────────────────────────────────────────

export class ProjectRecapJobs extends Context.Tag("ProjectRecapJobs")<
  ProjectRecapJobs,
  {
    /**
     * Start (or attach to) a recap job for a given (repo, period, periodStart).
     * Idempotent: per-(repo, period, periodStart) mutex prevents duplicate
     * fibers. Resume callers pass `recapId` so the existing row is reused.
     */
    readonly startJob: (
      params: StartRecapJobParams,
    ) => Effect.Effect<{ readonly recapId: string }, StartRecapJobError>;

    /**
     * Regenerate the recap for a period: mark the existing non-superseded
     * row 'superseded' and queue a fresh row. Returns the new id.
     */
    readonly regenerateForPeriod: (params: {
      readonly repoId: string;
      readonly period: RecapPeriod;
      readonly periodStart: string;
      readonly periodEnd: string;
    }) => Effect.Effect<{ readonly recapId: string }, StartRecapJobError>;

    readonly cancel: (recapId: string) => Effect.Effect<void>;

    /** Re-launch any rows left in `status='generating'` by a prior process. */
    readonly resumePending: () => Effect.Effect<void>;
  }
>() {}

// ── Live implementation ──────────────────────────────────────────────────────

export const ProjectRecapJobsLive = Layer.effect(
  ProjectRecapJobs,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const hub = yield* WebSocketHub;
    const recapService = yield* ProjectRecapService;
    const prService = yield* PullRequestService;
    const repoService = yield* RepositoryService;
    const settingsService = yield* SettingsService;

    const registry = yield* Ref.make(new Map<string, ActiveRecapJob>());
    const semaphore = yield* Effect.makeSemaphore(MAX_CONCURRENT_RECAP_JOBS);
    const startJobMutexes = yield* Ref.make(new Map<string, Effect.Semaphore>());

    const provideDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
      withDb(db, eff);

    const acquireStartJobMutex = (key: string): Effect.Effect<Effect.Semaphore> =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(startJobMutexes)).get(key);
        if (cached) return cached;
        const candidate = yield* Effect.makeSemaphore(1);
        return yield* Ref.modify(startJobMutexes, (map) => {
          const winner = map.get(key);
          if (winner) return [winner, map];
          const next = new Map(map);
          next.set(key, candidate);
          return [candidate, next];
        });
      });

    // ── Status chokepoint (CLAUDE.md invariant #11) ─────────────────────
    const setStatus = (
      recap: { id: string; repositoryId: string; period: RecapPeriod },
      status: "generating" | "complete" | "error" | "superseded",
      options?: { tokenUsage?: Record<string, number>; modelUsed?: string },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* provideDb(recapService.setStatus(recap.id, status, options));
        // Reload completedAt so the WS payload is accurate.
        const fresh = yield* provideDb(recapService.getById(recap.id)).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        const data: {
          recapId: string;
          repoId: string;
          period: RecapPeriod;
          status: typeof status;
          completedAt?: string;
        } = {
          recapId: recap.id,
          repoId: recap.repositoryId,
          period: recap.period,
          status,
        };
        if (fresh && fresh.completedAt) data.completedAt = fresh.completedAt;
        yield* hub.broadcast({ type: "recap:status-changed", data }).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchAll(() => Effect.void),
        );
        // For 'complete', also broadcast the fresh row so the UI can render
        // immediately without re-fetching.
        if (status === "complete" && fresh) {
          yield* hub.broadcast({ type: "recap:added", data: { recap: fresh } }).pipe(
            Effect.timeout("5 seconds"),
            Effect.catchAll(() => Effect.void),
          );
        }
      });

    const removeJob = (recapId: string) =>
      Ref.update(registry, (map) => {
        if (!map.has(recapId)) return map;
        const next = new Map(map);
        next.delete(recapId);
        return next;
      });

    // ── Source bundle assembly ──────────────────────────────────────────

    const buildSourceBundle = (
      repoFullName: string,
      params: {
        repoId: string;
        period: RecapPeriod;
        periodStart: string;
        periodEnd: string;
      },
      windowed: ReadonlyArray<ArchivedPrWithWalkthrough>,
    ): RecapSourceBundle => {
      const prs: RecapSourcePr[] = windowed.map((row) => {
        const pr = row.pr;
        return {
          id: pr.id,
          externalId: pr.externalId,
          title: pr.title,
          authorLogin: pr.authorLogin,
          status: (pr.status === "merged" ? "merged" : "closed") as "merged" | "closed",
          closedAt: pr.closedAt ?? "",
          sourceBranch: pr.sourceBranch,
          targetBranch: pr.targetBranch,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          url: pr.url,
          body: pr.body ? truncateBody(pr.body) : null,
          walkthrough: row.walkthrough
            ? {
                id: row.walkthrough.id,
                summary: row.walkthrough.summary,
                sentiment: row.walkthrough.sentiment ?? null,
                riskLevel:
                  row.walkthrough.riskLevel === "high" || row.walkthrough.riskLevel === "medium"
                    ? row.walkthrough.riskLevel
                    : "low",
                completedAt: row.walkthrough.completedAt ?? null,
              }
            : null,
        };
      });

      // Aggregate stats up-front so the agent has a reference baseline and
      // the read tool can hand it to them.
      let mergedCount = 0;
      let closedCount = 0;
      const authorSet = new Set<string>();
      let low = 0;
      let medium = 0;
      let high = 0;
      let missing = 0;
      for (const p of prs) {
        if (p.status === "merged") mergedCount++;
        else closedCount++;
        authorSet.add(p.authorLogin);
        if (p.walkthrough) {
          if (p.walkthrough.riskLevel === "high") high++;
          else if (p.walkthrough.riskLevel === "medium") medium++;
          else low++;
        } else {
          missing++;
        }
      }
      const stats: RecapSummaryStats = {
        prCount: prs.length,
        mergedCount,
        closedCount,
        authorCount: authorSet.size,
        riskBreakdown: { low, medium, high },
        walkthroughsMissingCount: missing,
      };

      return {
        repoId: params.repoId,
        repoFullName,
        period: params.period,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        prs,
        stats,
      };
    };

    // ── Job body ─────────────────────────────────────────────────────────

    const buildJobBody = (job: ActiveRecapJob): Effect.Effect<void> =>
      Effect.gen(function* () {
        debug("recap-jobs", "running agent for", job.recapId);

        // Repo metadata for the prompt.
        const repo = yield* provideDb(repoService.getRepoById(job.repoId)).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        if (!repo) {
          logError("recap-jobs", `repo ${job.repoId} not found — marking recap error`);
          yield* setStatus(
            {
              id: job.recapId,
              repositoryId: job.repoId,
              period: job.period,
            },
            "error",
          );
          return;
        }

        // Source PRs + walkthroughs for the window.
        const windowed = yield* provideDb(
          prService.listArchivedPrsForWindow(job.repoId, job.periodStart, job.periodEnd),
        ).pipe(Effect.catchAll(() => Effect.succeed([] as never[])));

        if (windowed.length === 0) {
          // Scheduler should have filtered empty windows out, but defend:
          // mark the row error with a clear reason rather than spinning.
          logError(
            "recap-jobs",
            `no archived PRs in window for recap ${job.recapId} — marking error`,
          );
          yield* setStatus(
            {
              id: job.recapId,
              repositoryId: job.repoId,
              period: job.period,
            },
            "error",
          );
          return;
        }

        const bundle = buildSourceBundle(repo.fullName, job, windowed);

        // Prior recaps for rolling context. Cheap query — at most a handful.
        const priorRecaps: ReadonlyArray<ProjectRecap> = yield* provideDb(
          recapService.getLatestForRepo(job.repoId, { limit: 5 }),
        ).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<ProjectRecap>)));

        const settings = yield* provideDb(settingsService.getSettings()).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );

        // Run the agent. The runner returns whether the agent reached the
        // validation gate (complete_recap returned success). On any error
        // we transition to 'error'; on success we transition to 'complete'.
        const result = yield* Effect.tryPromise({
          try: async () => {
            return await runRecapAgent({
              db,
              recapId: job.recapId,
              sourceBundle: bundle,
              priorRecaps,
              abortController: job.abortController,
              modelUsed: settings?.aiModel ?? "claude-opus-4-5",
              aiAgent: settings?.aiAgent ?? "claude",
              aiMaxTurns: settings?.aiMaxTurns ?? 12,
              onCompleted: () => {
                job.validatedComplete = true;
              },
            });
          },
          catch: (e) => new ValidationError({ message: String(e) }),
        }).pipe(
          Effect.catchAll((err) =>
            Effect.gen(function* () {
              logError("recap-jobs", `runRecapAgent failed for ${job.recapId}:`, err);
              return null;
            }),
          ),
        );

        if (job.cancelledByUser) {
          debug("recap-jobs", "job cancelled by user — leaving row for cleanup");
          return;
        }

        if (job.validatedComplete && result) {
          const completeOptions: { tokenUsage?: Record<string, number>; modelUsed?: string } = {};
          if (result.tokenUsage) completeOptions.tokenUsage = result.tokenUsage;
          if (result.modelUsed) completeOptions.modelUsed = result.modelUsed;
          yield* setStatus(
            {
              id: job.recapId,
              repositoryId: job.repoId,
              period: job.period,
            },
            "complete",
            completeOptions,
          );
          return;
        }

        // Agent terminated without validation. Mark error.
        yield* setStatus(
          {
            id: job.recapId,
            repositoryId: job.repoId,
            period: job.period,
          },
          "error",
        );
      });

    const launchJob = (job: ActiveRecapJob) =>
      Effect.gen(function* () {
        yield* Ref.update(registry, (map) => {
          const next = new Map(map);
          next.set(job.recapId, job);
          return next;
        });

        const scopedBody = buildJobBody(job).pipe(
          Effect.annotateLogs({ recapId: job.recapId, repoId: job.repoId }),
          semaphore.withPermits(1),
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              const interruptedOnly = Cause.isInterruptedOnly(cause);
              if (!interruptedOnly) {
                logError("recap-jobs", `job ${job.recapId} failed:`, Cause.pretty(cause));
                yield* setStatus(
                  {
                    id: job.recapId,
                    repositoryId: job.repoId,
                    period: job.period,
                  },
                  "error",
                );
              }
            }),
          ),
          Effect.ensuring(removeJob(job.recapId)),
        );

        const fiber = yield* Effect.forkDaemon(scopedBody);
        job.fiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
      });

    // ── Public API ──────────────────────────────────────────────────────

    const cancel = (recapId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(recapId);
        if (!job) return;
        job.cancelledByUser = true;
        try {
          if (!job.abortController.signal.aborted) {
            job.abortController.abort(new Error("Recap cancelled"));
          }
        } catch {
          /* already aborted */
        }
        if (job.fiber) {
          yield* Fiber.interrupt(job.fiber);
        }
      });

    const startJob = (
      params: StartRecapJobParams,
    ): Effect.Effect<{ readonly recapId: string }, StartRecapJobError> =>
      Effect.gen(function* () {
        const mutexKey = `${params.repoId}:${params.period}:${params.periodStart}`;
        const mutex = yield* acquireStartJobMutex(mutexKey);
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            // Resume path: caller passed an existing row id. Re-run the
            // agent against that row. No createPartial — the row already
            // exists and we'll write into it.
            let recapId = params.recapId;
            if (!recapId) {
              const created = yield* provideDb(
                recapService.createPartial({
                  repositoryId: params.repoId,
                  period: params.period,
                  periodStart: params.periodStart,
                  periodEnd: params.periodEnd,
                }),
              );
              recapId = created.id;
              // Announce the new row immediately so the UI can show a
              // "generating" placeholder.
              yield* hub
                .broadcast({
                  type: "recap:added",
                  data: { recap: created },
                })
                .pipe(
                  Effect.timeout("5 seconds"),
                  Effect.catchAll(() => Effect.void),
                );
            }

            // Already running? Reuse.
            const existing = (yield* Ref.get(registry)).get(recapId);
            if (existing) return { recapId };

            const job: ActiveRecapJob = {
              recapId,
              repoId: params.repoId,
              period: params.period,
              periodStart: params.periodStart,
              periodEnd: params.periodEnd,
              abortController: new AbortController(),
              fiber: null,
              cancelledByUser: false,
              validatedComplete: false,
            };
            yield* launchJob(job);
            return { recapId };
          }),
        );
      });

    const regenerateForPeriod = (params: {
      readonly repoId: string;
      readonly period: RecapPeriod;
      readonly periodStart: string;
      readonly periodEnd: string;
    }): Effect.Effect<{ readonly recapId: string }, StartRecapJobError> =>
      Effect.gen(function* () {
        // Create the new row first so we can stamp `supersededBy` on the
        // old one immediately. Mirrors WalkthroughJobs.supersedeWalkthrough.
        const newRow = yield* provideDb(
          recapService.createPartial({
            repositoryId: params.repoId,
            period: params.period,
            periodStart: params.periodStart,
            periodEnd: params.periodEnd,
          }),
        );

        const existing = yield* provideDb(
          recapService.findActiveForPeriod(params.repoId, params.period, params.periodStart),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (existing && existing.id !== newRow.id) {
          // Cancel any in-flight fiber for the old row.
          yield* cancel(existing.id);
          yield* provideDb(recapService.supersede(existing.id, newRow.id));
          yield* hub
            .broadcast({
              type: "recap:status-changed",
              data: {
                recapId: existing.id,
                repoId: existing.repositoryId,
                period: existing.period,
                status: "superseded",
              },
            })
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.catchAll(() => Effect.void),
            );
        }

        // Announce the fresh row so the UI swaps in immediately.
        yield* hub.broadcast({ type: "recap:added", data: { recap: newRow } }).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchAll(() => Effect.void),
        );

        return yield* startJob({
          recapId: newRow.id,
          repoId: params.repoId,
          period: params.period,
          periodStart: params.periodStart,
          periodEnd: params.periodEnd,
          trigger: "manual",
        });
      });

    const resumePending = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const rows = yield* provideDb(recapService.listGenerating());
        debug("recap-jobs", `resumePending: ${rows.length} row(s)`);
        for (const row of rows) {
          const attempts = yield* provideDb(recapService.incrementResumeAttempts(row.id));
          if (attempts > RECAP_MAX_RESUME_ATTEMPTS) {
            debug("recap-jobs", `recap ${row.id} exceeded resume attempts — marking error`);
            yield* setStatus(
              {
                id: row.id,
                repositoryId: row.repositoryId,
                period: row.period,
              },
              "error",
            );
            continue;
          }
          yield* startJob({
            recapId: row.id,
            repoId: row.repositoryId,
            period: row.period,
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            trigger: "resume",
          }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                logError(
                  "recap-jobs",
                  `resume startJob failed for ${row.id}:`,
                  Cause.pretty(cause),
                );
              }),
            ),
          );
        }
      });

    return {
      startJob,
      regenerateForPeriod,
      cancel,
      resumePending,
    };
  }),
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Trim PR body to ~2KB so the bundle stays bounded. */
function truncateBody(body: string): string {
  const MAX = 2000;
  if (body.length <= MAX) return body;
  return `${body.slice(0, MAX)}\n\n[…truncated…]`;
}
