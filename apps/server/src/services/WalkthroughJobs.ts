// The walkthrough orchestrator and the one owner of its lifecycle (invariants
// #2, #11). Runs live on the durable agent-job kernel (`jobs/agent-jobs.ts`),
// which owns the registry, the concurrency budget, cancel, resume-on-boot and
// the MCP token. What is walkthrough-specific lives here and in
// `walkthrough/`:
//
//   • `startJob` decides, under a per-PR lock, whether a request joins the run
//     already live, retires stale ones, imports a finished review (team cache,
//     restack carry) or launches a run — waiting for the repository clone when
//     it is still in progress.
//   • A run's inputs are planned once (`walkthrough/launch-plan.ts`) and its
//     launch recorded on the row, so every run of the row launches the same way.
//   • A run ends `complete` exactly when the journal passes the completion
//     check `complete_walkthrough` uses (`walkthrough/completion.ts`).
//   • `emitEvent` stamps durable events with the row's seq and broadcasts
//     live-only ones unsequenced.
//
// Content writes are NOT here: the agent's MCP tool handlers in
// walkthrough-tools own them.

import {
  isWalkthroughLiveEvent,
  REVIEW_MODE,
  type StartJobTrigger,
  type WalkthroughGenerationMode,
  type WalkthroughMode,
  type WalkthroughStreamEvent,
  ZERO_TOKEN_USAGE,
} from "@revv/shared";
import { SPAN, SPAN_ATTR } from "@revv/shared/telemetry";
import { eq } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Option } from "effect";
import { withWalkthroughMetrics } from "../ai/providers/walkthrough-metrics";
import { pullRequests } from "../db/schema/pull-requests";
import { repositories } from "../db/schema/repositories";
import { walkthroughs } from "../db/schema/walkthroughs";
import {
  type AiError,
  AiGenerationError,
  type CloneError,
  type CloneInProgressError,
  CloneNotReadyError,
  type DbError,
  type GitHubError,
  HeadShaMismatchError,
  type NotFoundError,
  type ValidationError,
} from "../domain/errors";
import { dbTry } from "../effects/db-try";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { withGitHubOrigin } from "../observability/github-ledger/origin";
import { withTraceAnchor } from "../observability/span-graft";
import { AiService } from "./Ai";
import { CacheService } from "./Cache";
import { DbService } from "./Db";
import { HunkScanService } from "./HunkScan";
import { JevService } from "./Jev";
import { makeStartJobMutex } from "./job-mutex";
import { type AgentRun, makeAgentJobs, type RunOutcome } from "./jobs/agent-jobs";
import { PrContextService } from "./PrContext";
import { Realtime } from "./Realtime";
import { RemoteWalkthroughCache } from "./RemoteWalkthroughCache";
import { RepoCloneService } from "./RepoClone";
import { ReviewService } from "./Review";
import { SettingsService } from "./Settings";
import { StackService } from "./stacks/StackService";
import { WalkthroughService } from "./Walkthrough";
import { WalkthroughSnapshotImporter } from "./WalkthroughSnapshotImporter";
import { orchestratorCompletionBlocker } from "./walkthrough/completion";
import { launchFor, planWalkthroughLaunch, providerConfigFor } from "./walkthrough/launch-plan";
import {
  CANCELLED,
  makeWalkthroughLifecycle,
  type WalkthroughFailure,
} from "./walkthrough/lifecycle";
import {
  MAX_AUTO_CONTINUATIONS,
  runWalkthrough,
  type WalkthroughRunInputs,
} from "./walkthrough/run";
import {
  type JudgmentServices,
  makeWalkthroughRunContext,
  type WalkthroughRunContext,
} from "./walkthrough/run-context";
import { exportWalkthroughSnapshot } from "./walkthrough-snapshot";

/** Cap on concurrent walkthrough runs. Additional runs queue on the kernel's semaphore. */
const MAX_CONCURRENT_JOBS = 5;

const CLONE_WAIT_MS = 20 * 60 * 1000;
const CLONE_POLL_MS = 2_000;

const isUserInitiated = (trigger: StartJobTrigger): boolean =>
  trigger === "user" || trigger === "external_agent" || trigger === "stack_review";

export interface StartJobParams {
  readonly prId: string;
  readonly trigger: StartJobTrigger;
  readonly walkthroughId?: string;
  readonly mode?: WalkthroughMode;
  readonly generationMode?: WalkthroughGenerationMode;
  /**
   * Review exactly this head or nothing. Checked under the per-PR lock
   * against the head GitHub serves — a mismatch fails with
   * `HeadShaMismatchError` before anything is cancelled — and, once it
   * matches, every other head's review in this mode is retired, as
   * PollScheduler would on its next tick: the PR is at this head, so they
   * are stale.
   */
  readonly expectedHeadSha?: string;
}

export interface StartJobResult {
  readonly walkthroughId: string;
  /** An in-flight run (or the row being resumed) was returned; nothing new launched. */
  readonly reused: boolean;
}

const otherWalkthroughMode = (mode: WalkthroughMode): WalkthroughMode =>
  mode === REVIEW_MODE.author ? REVIEW_MODE.reviewer : REVIEW_MODE.author;

export type StartJobError =
  | AiError
  | CloneError
  | CloneInProgressError
  | CloneNotReadyError
  | GitHubError
  | HeadShaMismatchError
  | NotFoundError
  | DbError
  | ValidationError;

/** A run's body failed outright: say why in the user's terms. */
function crashFailure(cause: Cause.Cause<unknown>): WalkthroughFailure {
  const failure = Cause.findErrorOption(cause);
  if (Option.isNone(failure)) {
    return { reason: "crashed", message: "Walkthrough generation failed" };
  }
  const err = failure.value as { _tag?: string; message?: string; cause?: unknown };
  const inner = err.cause as { _tag?: string } | undefined;
  const cloneFailed = inner?._tag === "CloneNotReadyError" || inner?._tag === "CloneError";
  return {
    reason: cloneFailed
      ? "clone_failed"
      : err._tag === "AiNotConfiguredError"
        ? "agent_error"
        : "crashed",
    message:
      err.message ??
      (err.cause instanceof Error ? err.cause.message : String(err.cause ?? failure.value)),
  };
}

export class WalkthroughJobs extends Context.Service<
  WalkthroughJobs,
  {
    /**
     * Start (or attach to) a walkthrough run for a PR. Idempotent: the unique
     * index on (pullRequestId, prHeadSha, mode, generationMode) makes a
     * concurrent duplicate land on the same row, and a live run is returned.
     */
    readonly startJob: (params: StartJobParams) => Effect.Effect<StartJobResult, StartJobError>;

    /**
     * Probe the remote team cache for `(prId, headSha)` and, on a hit,
     * import it and complete the row without an agent. False on a miss or
     * any failure (logged, never raised): the `/current` read hydrates a
     * first page load from the team cache instead of offering Generate.
     */
    readonly tryHydrateFromRemoteCache: (
      prId: string,
      headSha: string,
      repoFullName: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<boolean>;

    readonly findActiveByPr: (
      prId: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<{ readonly walkthroughId: string; readonly prHeadSha: string } | null>;

    /** The user's Stop: the row ends `error` with end reason `cancelled`, still resumable. */
    readonly cancel: (walkthroughId: string) => Effect.Effect<void>;

    /**
     * A user's Resume of an `error` row: back to `generating` with a fresh
     * resume budget and its content kept, the launch re-resolved from the
     * current settings (the user may have fixed the agent since). No-op when
     * the row isn't in `error`.
     */
    readonly reviveFromError: (walkthroughId: string) => Effect.Effect<void, DbError>;

    readonly resumePending: () => Effect.Effect<void>;

    /**
     * Stop the PR's runs and supersede its rows (invariant #7): in `mode`, or
     * every perspective. `exceptHeadSha` spares rows already at that head —
     * PollScheduler's "the head moved" sweep must not retire a run the user
     * started at the new head before the poll saw it. Regenerate passes none.
     */
    readonly supersedeForPr: (
      prId: string,
      exceptHeadSha?: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<void, DbError>;

    /**
     * Announce a walkthrough event on the account's SSE bus. A durable event
     * is stamped with the row's seq (`walkthrough:event`) and must already be
     * committed (invariant #8); a live-only one goes out unsequenced
     * (`walkthrough:live`).
     */
    readonly emitEvent: (
      walkthroughId: string,
      event: WalkthroughStreamEvent,
    ) => Effect.Effect<void>;

    /**
     * The run a `/mcp/walkthrough` bearer token belongs to, while it is live.
     * A resolved token counts as agent activity for the run's idle deadline.
     */
    readonly resolveSessionToken: (
      token: string,
    ) => Effect.Effect<AgentRun<WalkthroughRunContext> | null>;
  }
>()("WalkthroughJobs") {}

export const WalkthroughJobsLive = Layer.effect(
  WalkthroughJobs,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const ai = yield* AiService;
    const prContextService = yield* PrContextService;
    const repoCloneService = yield* RepoCloneService;
    const reviewService = yield* ReviewService;
    const settingsService = yield* SettingsService;
    const walkthroughService = yield* WalkthroughService;
    const remoteCache = yield* RemoteWalkthroughCache;
    const jevService = yield* JevService;
    const hunkScanService = yield* HunkScanService;
    const cacheService = yield* CacheService;
    const snapshotImporter = yield* WalkthroughSnapshotImporter;
    const realtime = yield* Realtime;
    const stackService = yield* StackService;

    // Serializes `startJob` per PR, so the check-and-launch is atomic: two
    // concurrent starts can't both pass the liveness check.
    const startJobMutex = yield* makeStartJobMutex();

    const provideDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
      withDb(db, eff);

    const eventTargets = (
      walkthroughId: string,
    ): Effect.Effect<{ prId: string; accountId: string } | null> =>
      Effect.gen(function* () {
        const run = yield* jobs.running(walkthroughId);
        if (run) return { prId: run.context.prId, accountId: run.context.accountId };
        // No live run: a chat edit on a completed walkthrough (invariant #7's carve-out).
        return yield* dbTry("walkthrough event targets", () =>
          db
            .select({ prId: walkthroughs.pullRequestId, accountId: repositories.accountId })
            .from(walkthroughs)
            .innerJoin(pullRequests, eq(pullRequests.id, walkthroughs.pullRequestId))
            .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
            .where(eq(walkthroughs.id, walkthroughId))
            .get(),
        ).pipe(
          Effect.map((row) => row ?? null),
          // Best effort: clients reconcile from the DB (invariant #8).
          Effect.orElseSucceed(() => null),
        );
      });

    const emitEvent = (walkthroughId: string, event: WalkthroughStreamEvent): Effect.Effect<void> =>
      Effect.withSpan(SPAN.walkthroughEmitEvent, {
        attributes: { [SPAN_ATTR.walkthroughId]: walkthroughId, eventType: event.type },
      })(
        Effect.gen(function* () {
          const targets = yield* eventTargets(walkthroughId);
          if (targets === null) {
            debug("wt-trace", `emitEvent-no-target wt=${walkthroughId} type=${event.type}`);
            return;
          }
          if (isWalkthroughLiveEvent(event)) {
            return yield* realtime.toAccount(targets.accountId, {
              type: "walkthrough:live",
              data: { prId: targets.prId, walkthroughId, event },
            });
          }
          // The seq is bumped in the DB, so it survives kill -9, resumes and
          // chat edits after completion. An event whose seq didn't commit isn't
          // sent; clients reconcile from the DB.
          const seq = yield* provideDb(walkthroughService.bumpSeq(walkthroughId)).pipe(
            Effect.catchTag("DbError", (err) =>
              Effect.sync(() => {
                logError("walkthrough-jobs", `emitEvent ${event.type} not sequenced:`, err.message);
                return null;
              }),
            ),
          );
          if (seq === null) return;
          yield* realtime.toAccount(targets.accountId, {
            type: "walkthrough:event",
            data: { prId: targets.prId, walkthroughId, seq, event },
          });
        }),
      );

    const lifecycle = makeWalkthroughLifecycle({
      db,
      walkthroughs: walkthroughService,
      remoteCache,
      emit: emitEvent,
    });

    const settle = (
      walkthroughId: string,
      outcome: RunOutcome<WalkthroughFailure>,
      run: AgentRun<WalkthroughRunContext> | null,
    ): Effect.Effect<void, DbError> => {
      switch (outcome.kind) {
        case "complete":
          return lifecycle.complete(walkthroughId, run?.context.tokenUsage ?? ZERO_TOKEN_USAGE);
        case "failed":
          return lifecycle.fail(walkthroughId, outcome.failure);
        case "stopped":
          return lifecycle.fail(walkthroughId, CANCELLED);
      }
    };

    // Launched with a resume, so a boot that finds a row still `generating`
    // runs it again through `startJob` against its own journal.
    const relaunch = (walkthroughId: string): Effect.Effect<void, StartJobError> =>
      Effect.gen(function* () {
        const row = yield* dbTry("walkthrough relaunch read", () =>
          db
            .select({
              prId: walkthroughs.pullRequestId,
              mode: walkthroughs.mode,
              generationMode: walkthroughs.generationMode,
              status: walkthroughs.status,
            })
            .from(walkthroughs)
            .where(eq(walkthroughs.id, walkthroughId))
            .get(),
        );
        if (row?.status !== "generating") return;
        yield* startJob({
          prId: row.prId,
          trigger: "resume",
          walkthroughId,
          mode: row.mode,
          // The row's generationMode keeps `createPartial` on this row.
          generationMode: row.generationMode === "incremental" ? "incremental" : "full",
        });
      });

    const jobs = yield* makeAgentJobs<WalkthroughRunContext, WalkthroughFailure>({
      name: "walkthrough-jobs",
      concurrency: MAX_CONCURRENT_JOBS,
      turnsPerRun: 1 + MAX_AUTO_CONTINUATIONS,
      journal: {
        generating: Effect.map(provideDb(walkthroughService.listGenerating()), (rows) =>
          rows.map((row) => row.id),
        ),
        bumpResumeAttempts: (walkthroughId) =>
          provideDb(walkthroughService.incrementResumeAttempts(walkthroughId)),
        completionBlocker: (walkthroughId) =>
          dbTry("walkthrough completion check", () =>
            orchestratorCompletionBlocker(db, walkthroughId),
          ),
      },
      settle,
      crashed: crashFailure,
      resumeExhausted: {
        reason: "resume_budget",
        message: "Walkthrough failed after repeated retries. Try regenerating.",
      },
      relaunch,
    });

    /** Waits on a clone in progress; null once it is ready. */
    const awaitClone = (repoId: string, walkthroughId: string) =>
      Effect.gen(function* () {
        const deadline = Date.now() + CLONE_WAIT_MS;
        const waiting = emitEvent(walkthroughId, {
          type: "phase",
          data: { phase: "connecting", message: "Waiting for the repository clone…" },
        });
        yield* waiting;
        for (let poll = 1; ; poll++) {
          const clone = yield* repoCloneService.getCloneStatus(repoId);
          if (clone.status === "ready") return null;
          if (clone.status === "error" || Date.now() > deadline) {
            return {
              kind: "failed" as const,
              failure: {
                reason: "clone_failed" as const,
                message:
                  clone.status === "error"
                    ? `Repository clone failed: ${clone.error ?? "unknown error"} — check Settings`
                    : "Repository clone is taking too long — check Settings",
              },
            };
          }
          // A heartbeat for the client's stall watchdog.
          if (poll % 15 === 0) yield* waiting;
          yield* Effect.sleep(CLONE_POLL_MS);
        }
      });

    const launchRun = (input: {
      readonly walkthroughId: string;
      readonly prId: string;
      readonly accountId: string;
      readonly mode: WalkthroughMode;
      readonly prHeadSha: string;
      readonly trigger: StartJobTrigger;
      readonly cloneInProgress: boolean;
      readonly inputs: WalkthroughRunInputs;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { walkthroughId, inputs } = input;
        const services = yield* Effect.context<never>();
        const runSync = Effect.runSyncWith(services);
        const runPromise = Effect.runPromiseWith(services);
        // Called from the tool handlers and the agent's update stream, which
        // must never fail on a broadcast.
        const emitNow = (event: WalkthroughStreamEvent): void => {
          try {
            runSync(emitEvent(walkthroughId, event));
          } catch (err) {
            logError(
              "walkthrough-jobs",
              `emit ${event.type} failed for ${walkthroughId}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        };
        const runJudgment = <A>(effect: Effect.Effect<A, never, JudgmentServices>) =>
          runPromise(
            effect.pipe(
              Effect.provideService(JevService, jevService),
              Effect.provideService(SettingsService, settingsService),
              Effect.provideService(CacheService, cacheService),
              Effect.provideService(DbService, { db }),
            ),
          );

        // Before the fork, so it precedes every event of the run.
        yield* emitEvent(walkthroughId, {
          type: "lifecycle:started",
          data: {
            walkthroughId,
            prHeadSha: input.prHeadSha,
            mode: input.mode,
            trigger: input.trigger,
            ...(inputs.assignedRisk !== null ? { riskLevel: inputs.assignedRisk } : {}),
            modelUsed: inputs.plan.model,
          },
        });

        yield* jobs.launch({
          id: walkthroughId,
          context: () =>
            makeWalkthroughRunContext({
              db,
              walkthroughId,
              prId: input.prId,
              accountId: input.accountId,
              mode: input.mode,
              prHeadSha: input.prHeadSha,
              emit: emitNow,
              broadcastThreadEvent: (msg) =>
                void runPromise(
                  input.accountId === ""
                    ? realtime.toPr(input.prId, msg)
                    : realtime.toAccount(input.accountId, msg),
                ),
              runJudgment,
            }),
          ...(input.cloneInProgress
            ? { queue: () => awaitClone(inputs.repoId, walkthroughId) }
            : {}),
          body: (run) =>
            runWalkthrough(
              {
                db,
                ai,
                repoClone: repoCloneService,
                hunkScan: hunkScanService,
                jev: jevService,
                publish: emitNow,
                announceLeads: (leads) =>
                  emitEvent(walkthroughId, { type: "leads", data: { leads } }),
              },
              run,
              inputs,
            ),
          instrument: (_run, effect) =>
            effect.pipe(
              // Before the span below, so the anchor resolves to it: the ACP
              // driver and the MCP handlers run outside this fiber and file
              // their spans under it.
              withTraceAnchor(walkthroughId),
              withWalkthroughMetrics(walkthroughId),
              Effect.annotateLogs({ walkthroughId, prId: input.prId }),
              // The forked work's real duration: the walkthrough-gen-duration KPI.
              Effect.withSpan(SPAN.walkthroughGenerate, {
                attributes: {
                  [SPAN_ATTR.walkthroughId]: walkthroughId,
                  [SPAN_ATTR.prId]: input.prId,
                  [SPAN_ATTR.trigger]: input.trigger,
                  [SPAN_ATTR.model]: inputs.plan.model,
                },
              }),
              withGitHubOrigin("walkthrough:job"),
            ),
        });
      });

    const findActiveByPr = (
      prId: string,
      mode: WalkthroughMode = "reviewer",
    ): Effect.Effect<{ readonly walkthroughId: string; readonly prHeadSha: string } | null> =>
      Effect.map(jobs.runs, (runs) => {
        const run = runs.find((r) => r.context.prId === prId && r.context.mode === mode);
        return run ? { walkthroughId: run.id, prHeadSha: run.context.prHeadSha } : null;
      });

    const supersedeForPr = (
      prId: string,
      exceptHeadSha?: string,
      mode?: WalkthroughMode,
    ): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        // Stop the runs first, so none writes after its row is superseded.
        for (const run of yield* jobs.runs) {
          if (run.context.prId !== prId) continue;
          if (mode !== undefined && run.context.mode !== mode) continue;
          if (exceptHeadSha !== undefined && run.context.prHeadSha === exceptHeadSha) continue;
          yield* jobs.stop(run.id, "superseded");
        }
        yield* lifecycle.supersede(prId, exceptHeadSha, mode);
      });

    /** Import a snapshot into the row and complete it, or false to fall through to the agent. */
    const importReview = (
      walkthroughId: string,
      snapshot: Parameters<typeof snapshotImporter.import>[0]["snapshot"],
      source: "remote" | "restack",
      afterImport: Effect.Effect<void, DbError> = Effect.void,
    ): Effect.Effect<boolean, DbError> =>
      Effect.gen(function* () {
        const imported = yield* provideDb(
          snapshotImporter.import({ walkthroughId, snapshot }),
        ).pipe(Effect.result);
        if (imported._tag === "Failure") {
          logError(
            "walkthrough-jobs",
            `${source} import failed wt=${walkthroughId} — falling through to agent: ${imported.failure.reason}`,
          );
          return false;
        }
        yield* afterImport;
        yield* lifecycle.complete(walkthroughId, ZERO_TOKEN_USAGE, source);
        return true;
      });

    const startJob = (params: StartJobParams): Effect.Effect<StartJobResult, StartJobError> =>
      Effect.gen(function* () {
        if (params.walkthroughId !== undefined && (yield* jobs.running(params.walkthroughId))) {
          return { walkthroughId: params.walkthroughId, reused: true };
        }
        const mutex = yield* startJobMutex.acquire(params.prId);
        return yield* mutex.withPermits(1)(startJobBody(params));
      });

    const startJobBody = (params: StartJobParams): Effect.Effect<StartJobResult, StartJobError> =>
      Effect.gen(function* () {
        const mode = params.mode ?? "reviewer";
        const existing = yield* findActiveByPr(params.prId, mode);
        if (
          params.walkthroughId !== undefined &&
          existing?.walkthroughId === params.walkthroughId
        ) {
          return { walkthroughId: existing.walkthroughId, reused: true };
        }

        const resolved = yield* prContextService.withDiff(params.prId);
        const { pr, repo, client, meta, files, commits } = resolved;
        const token = client.token;
        const pinnedHead = params.expectedHeadSha?.toLowerCase();
        if (pinnedHead !== undefined && meta.headSha.toLowerCase() !== pinnedHead) {
          return yield* Effect.fail(
            new HeadShaMismatchError({ expectedHeadSha: pinnedHead, githubHeadSha: meta.headSha }),
          );
        }

        if (existing !== null) {
          if (existing.prHeadSha === meta.headSha) {
            if (
              params.walkthroughId === undefined ||
              params.walkthroughId === existing.walkthroughId
            ) {
              return { walkthroughId: existing.walkthroughId, reused: true };
            }
          } else {
            // The PR moved past the live run's head: it is stale (invariant #7).
            yield* supersedeForPr(pr.id, meta.headSha, mode);
          }
        }

        // A run waits for a clone in progress. A resumed one waits for a
        // `pending` clone too: at boot, clones cut off mid-way restart as
        // `pending`.
        const clone = yield* repoCloneService.getCloneStatus(repo.id);
        const cloneInProgress =
          clone.status === "cloning" || (clone.status === "pending" && params.trigger === "resume");
        if (clone.status !== "ready" && !cloneInProgress) {
          const message =
            clone.status === "error"
              ? `Repository clone failed: ${clone.error ?? "unknown error"} — check Settings`
              : "Repository has not been cloned yet — check Settings";
          return yield* Effect.fail(
            new AiGenerationError({ cause: new CloneNotReadyError({ repoId: repo.id }), message }),
          );
        }

        // See `expectedHeadSha`. After the clone check, so a run that can't
        // start leaves the previous review standing.
        if (pinnedHead !== undefined) yield* supersedeForPr(pr.id, meta.headSha, mode);

        // One perspective at a time. Both write their AI threads into the PR's
        // one review, so a fresh user start retires the other
        // perspective's rows (and their unsubmitted threads), or Submit would
        // post both walkthroughs' comments.
        if (isUserInitiated(params.trigger)) {
          yield* supersedeForPr(pr.id, undefined, otherWalkthroughMode(mode));
        }

        const requestedGenerationMode = params.generationMode ?? "full";
        let partial = yield* provideDb(
          walkthroughService.getPartial(pr.id, meta.headSha, mode, requestedGenerationMode),
        );
        if (params.walkthroughId !== undefined && partial?.id !== params.walkthroughId) {
          partial = null;
        }
        if (isUserInitiated(params.trigger) && partial?.status === "error") partial = null;

        const reviewSessionId = yield* provideDb(reviewService.sessionIdFor(pr.id));
        const settings = yield* settingsService.getSettings();
        const agent = yield* settingsService.resolveAgent();

        const decision = yield* planWalkthroughLaunch({
          db,
          resolved,
          mode,
          requestedGenerationMode,
          existing: partial,
          trigger: params.trigger,
          settings,
          agent,
          snapshotStack: stackService
            .snapshot(resolved)
            .pipe(
              Effect.provideService(DbService, { db }),
              Effect.provideService(CacheService, cacheService),
            ),
          cacheProbe:
            partial === null
              ? remoteCache.probe(repo.fullName, meta.headSha, mode)
              : Effect.succeed(false),
        }).pipe(
          Effect.provideService(WalkthroughService, walkthroughService),
          Effect.provideService(JevService, jevService),
          Effect.provideService(CacheService, cacheService),
          Effect.provideService(DbService, { db }),
        );

        // Only the orchestrator creates walkthrough rows; MCP handlers only
        // update them.
        const walkthroughId = yield* provideDb(
          walkthroughService.createPartial({
            ...((partial?.id ?? params.walkthroughId)
              ? { id: partial?.id ?? params.walkthroughId }
              : {}),
            reviewSessionId,
            prId: pr.id,
            modelUsed: decision.plan.model,
            prHeadSha: meta.headSha,
            mode,
            generationMode: decision.generationMode,
            parentWalkthroughId: decision.parentWalkthroughId,
            baseHeadSha: decision.baseHeadSha,
            forceNew: isUserInitiated(params.trigger) && decision.generationMode === "full",
            prCommits: commits,
            stackContext: decision.stack,
            diffFingerprint: decision.diffFingerprint,
            ...(decision.owner.generatedBy ? { generatedBy: decision.owner.generatedBy } : {}),
            // At insert, not a follow-up UPDATE: no kill-9 window without the tier.
            ...(decision.risk !== null ? { risk: decision.risk } : {}),
            providerConfig: decision.providerConfig,
            launchPlan: decision.plan,
          }),
        );
        // A row from before launch plans: record the one its runs use now.
        if (partial !== null && decision.planIsNew) {
          yield* provideDb(
            walkthroughService.recordLaunch(walkthroughId, decision.plan, decision.providerConfig),
          );
        }

        if (decision.restack !== null) {
          const fromWalkthroughId = decision.restack.fromWalkthroughId;
          const snapshot = yield* Effect.try({
            try: () =>
              exportWalkthroughSnapshot(db, {
                walkthroughId: fromWalkthroughId,
                repoFullName: repo.fullName,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) =>
              Effect.sync(() => {
                logError(
                  "walkthrough-jobs",
                  `restack export of ${fromWalkthroughId} failed — falling through to agent:`,
                  cause,
                );
                return Option.none();
              }),
            ),
          );
          if (
            Option.isSome(snapshot) &&
            (yield* importReview(
              walkthroughId,
              snapshot.value,
              "restack",
              provideDb(walkthroughService.markCarriedFrom(walkthroughId, fromWalkthroughId)),
            ))
          ) {
            return { walkthroughId, reused: false };
          }
        }

        if (partial === null) {
          const snapshot = yield* remoteCache.fetch(repo.fullName, meta.headSha, mode);
          if (
            Option.isSome(snapshot) &&
            (yield* importReview(walkthroughId, snapshot.value, "remote"))
          ) {
            return { walkthroughId, reused: false };
          }
        }

        const assignedRisk =
          decision.risk?.level ??
          (partial !== null && partial.riskConfidence != null ? partial.riskLevel : null);
        yield* launchRun({
          walkthroughId,
          prId: pr.id,
          accountId: decision.owner.accountId,
          mode,
          prHeadSha: meta.headSha,
          trigger: params.trigger,
          cloneInProgress,
          inputs: {
            pr: {
              id: pr.id,
              title: pr.title,
              body: pr.body,
              sourceBranch: pr.sourceBranch,
              targetBranch: pr.targetBranch,
              url: pr.url,
              externalId: pr.externalId,
            },
            repoId: repo.id,
            repoFullName: repo.fullName,
            githubHost: repo.githubHost,
            token,
            files,
            generationMode: decision.generationMode,
            parentWalkthroughId: decision.parentWalkthroughId,
            baseHeadSha: decision.baseHeadSha,
            resumed: partial !== null,
            plan: decision.plan,
            assignedRisk,
            stack: decision.stack,
            parentFingerprint: decision.parentFingerprint,
          },
        });
        return { walkthroughId, reused: false };
      });

    const reviveFromError = (walkthroughId: string): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        if (!(yield* provideDb(walkthroughService.revive(walkthroughId)))) return;
        const row = yield* dbTry("walkthrough launch plan", () =>
          db
            .select({ launchPlan: walkthroughs.launchPlan })
            .from(walkthroughs)
            .where(eq(walkthroughs.id, walkthroughId))
            .get(),
        );
        if (!row?.launchPlan) return;
        const settings = yield* settingsService.getSettings();
        const agent = yield* settingsService.resolveAgent();
        const plan = {
          ...row.launchPlan,
          ...launchFor(settings, agent, row.launchPlan.sizing),
        };
        yield* provideDb(
          walkthroughService.recordLaunch(
            walkthroughId,
            plan,
            providerConfigFor(plan, settings.aiMaxTurns),
          ),
        );
      });

    const tryHydrateFromRemoteCache = (
      prId: string,
      headSha: string,
      repoFullName: string,
      mode: WalkthroughMode = "reviewer",
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const snapshot = yield* remoteCache.fetch(repoFullName, headSha, mode);
        if (Option.isNone(snapshot)) return false;

        const reviewSessionId = yield* provideDb(reviewService.sessionIdFor(prId));
        const walkthroughId = yield* provideDb(
          walkthroughService.createPartial({
            reviewSessionId,
            prId,
            modelUsed: snapshot.value.modelUsed,
            prHeadSha: headSha,
            mode,
            generatedBy: snapshot.value.generatedBy,
            providerConfig: snapshot.value.providerConfig,
          }),
        );
        return yield* importReview(walkthroughId, snapshot.value, "remote");
      }).pipe(
        Effect.catch((e) => {
          logError(
            "walkthrough-jobs",
            `tryHydrateFromRemoteCache failed pr=${prId}: ${e instanceof Error ? e.message : String(e)}`,
          );
          return Effect.succeed(false);
        }),
      );

    return {
      startJob,
      findActiveByPr,
      cancel: (walkthroughId) => jobs.stop(walkthroughId, "user"),
      reviveFromError,
      resumePending: () => jobs.resumePending,
      supersedeForPr,
      emitEvent,
      resolveSessionToken: jobs.resolveToken,
      tryHydrateFromRemoteCache,
    };
  }),
);
