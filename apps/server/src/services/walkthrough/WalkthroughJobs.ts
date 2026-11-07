// The walkthrough orchestrator and the one owner of its lifecycle (invariants
// #2, #11). Runs live on the durable agent-job kernel (`../jobs/agent-jobs.ts`),
// which owns the registry, the concurrency budget, cancel, resume-on-boot and
// the MCP token. What is walkthrough-specific lives here and beside it:
//
//   • `startJob` decides, under a per-PR lock, what a request lands on: the
//     run already live, the row already at the head, or a new row — which
//     takes over a finished review (restack carry, team cache) when one
//     exists, and is planned and launched only when none does. `/current`'s
//     team-cache hydrate is the same decision, import-only.
//   • A resume — on boot, or the user's — runs an existing row exactly as its
//     journal records it: its head, its launch plan, its stack. A row whose
//     head GitHub (as last synced) has moved past is superseded instead.
//   • A run ends `complete` exactly when the journal passes the completion
//     check `complete_walkthrough` uses (`completion.ts`).
//   • `emitEvent` stamps durable events with the row's seq and broadcasts
//     live-only ones unsequenced.
//
// Content writes are NOT here: the agent's MCP tool handlers in
// walkthrough-tools own them.

import {
  isWalkthroughLiveEvent,
  REVIEW_MODE,
  type RiskLevel,
  type ServerEventMessage,
  type WalkthroughGenerationMode,
  type WalkthroughMode,
  type WalkthroughStartTrigger,
  type WalkthroughStreamEvent,
  ZERO_TOKEN_USAGE,
} from "@revv/shared";
import { SPAN, SPAN_ATTR } from "@revv/shared/telemetry";
import { Cause, Context, Effect, Layer, Option } from "effect";
import type { JobStartStateInput } from "../../ai/jev/state";
import { withWalkthroughMetrics } from "../../ai/providers/walkthrough-metrics";
import {
  AiGenerationError,
  type DbError,
  type GitHubError,
  HeadShaMismatchError,
} from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { debug, logError } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { withTraceAnchor } from "../../observability/span-graft";
import { AiService } from "../Ai";
import { CacheService } from "../Cache";
import { RepoCloneService } from "../clone/RepoClone";
import { DbService } from "../Db";
import { DiffCacheService, toGitHubFileShape } from "../DiffCache";
import { HunkScanService } from "../hunk-scan/HunkScan";
import { JevService } from "../Jev";
import { makeStartJobMutex } from "../job-mutex";
import { type AgentRun, makeAgentJobs, type RunOutcome } from "../jobs/agent-jobs";
import { type PrContextBasic, type PrContextError, PrContextService } from "../PrContext";
import { Realtime } from "../Realtime";
import { ReviewService } from "../Review";
import { SettingsService } from "../Settings";
import { StackService } from "../stacks/StackService";
import type { WalkthroughSnapshotV2 } from "./cache-format";
import { orchestratorCompletionBlocker } from "./completion";
import { loadWalkthroughRow, type WalkthroughRow } from "./content";
import {
  generatedByOf,
  launchFor,
  parentFingerprintOf,
  planLaunch,
  planNewRow,
  providerConfigFor,
} from "./launch-plan";
import {
  CANCELLED,
  cloneFailure,
  makeWalkthroughLifecycle,
  type WalkthroughFailure,
} from "./lifecycle";
import type { PromptFile } from "./prompt-files";
import { RemoteWalkthroughCache } from "./RemoteWalkthroughCache";
import type { RestackCarry } from "./restack";
import { MAX_AUTO_CONTINUATIONS, runWalkthrough, type WalkthroughRunInputs } from "./run";
import {
  type JudgmentServices,
  makeWalkthroughRunContext,
  type WalkthroughRunContext,
} from "./run-context";
import { exportWalkthroughSnapshot } from "./snapshot";
import { WalkthroughService } from "./Walkthrough";
import { WalkthroughSnapshotImporter } from "./WalkthroughSnapshotImporter";

/** Cap on concurrent walkthrough runs. Additional runs queue on the kernel's semaphore. */
const MAX_CONCURRENT_JOBS = 5;

const CLONE_WAIT_MS = 20 * 60 * 1000;
const CLONE_POLL_MS = 2_000;

/**
 * What a request does with the reviews the PR already has in its perspective:
 *
 *   • `none` — joins a live run at the head; a finished (complete or failed)
 *     row at the head is returned as it is. Automatic triggers: they never
 *     redo a review the user can see, nor retry one that failed.
 *   • `finished` — joins a live run at the head; a finished row at the head
 *     is replaced by a new one, and the other perspective's reviews are
 *     retired. The user's Generate, an external agent, a stack review.
 *   • `all` — every review of the PR, live or finished, in both perspectives
 *     and at every head, is stopped and superseded first. Regenerate.
 */
export type ReplacePolicy = "none" | "finished" | "all";

export interface StartJobParams {
  readonly prId: string;
  /** Who asked: telemetry, and `lifecycle:started`. Decides nothing. */
  readonly trigger: WalkthroughStartTrigger;
  readonly replace: ReplacePolicy;
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
  /** An existing run or row was returned; nothing new launched. */
  readonly reused: boolean;
}

export type StartJobError = PrContextError | HeadShaMismatchError | AiGenerationError;

/**
 * How a user's Resume went: the row runs again (or already was running), the
 * PR moved past its head and it was superseded, or there was nothing to resume.
 */
export type ResumeOutcome = "resumed" | "superseded" | "gone";

export type ResumeError = PrContextError | GitHubError;

const otherWalkthroughMode = (mode: WalkthroughMode): WalkthroughMode =>
  mode === REVIEW_MODE.author ? REVIEW_MODE.reviewer : REVIEW_MODE.author;

/** A run's body failed outright, outside every failure it maps itself. */
function crashFailure(cause: Cause.Cause<unknown>): WalkthroughFailure {
  const error = Cause.findErrorOption(cause);
  return {
    reason: "crashed",
    message:
      Option.isSome(error) && error.value instanceof Error && error.value.message
        ? error.value.message
        : "Walkthrough generation failed",
  };
}

const IMPORT_FAILED: WalkthroughFailure = {
  reason: "crashed",
  message:
    "The team's review of this head couldn't be imported. Resume or regenerate to review it.",
};

/** A finished review a new row can take over instead of running an agent. */
interface Carry {
  readonly snapshot: WalkthroughSnapshotV2;
  readonly source: "remote" | "restack";
  readonly fromWalkthroughId?: string;
}

export class WalkthroughJobs extends Context.Service<
  WalkthroughJobs,
  {
    /**
     * Review a PR's head: join, return, or create and run the row the
     * request lands on (see {@link ReplacePolicy}). Concurrent requests for
     * one PR are serialized, so they land on the same row.
     */
    readonly startJob: (params: StartJobParams) => Effect.Effect<StartJobResult, StartJobError>;

    /**
     * `/current` found no row at the PR's synced head: when the team cache
     * holds a review of it, import it into a new row and complete it without
     * an agent. False on a miss, or on any failure (logged, never raised).
     */
    readonly importFromTeamCache: (prId: string, mode: WalkthroughMode) => Effect.Effect<boolean>;

    /**
     * The user's Resume of a row that died (`generating`) or stopped
     * (`error`). An errored row is revived first — back to `generating`, a
     * fresh resume budget, its content kept, its launch re-resolved from the
     * current settings (the user may have fixed the agent since).
     */
    readonly resume: (walkthroughId: string) => Effect.Effect<ResumeOutcome, ResumeError>;

    readonly findActiveByPr: (
      prId: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<{ readonly walkthroughId: string; readonly prHeadSha: string } | null>;

    /** The user's Stop: the row ends `error` with end reason `cancelled`, still resumable. */
    readonly cancel: (walkthroughId: string) => Effect.Effect<void>;

    readonly resumePending: () => Effect.Effect<void>;

    /**
     * Stop the PR's runs and supersede its rows (invariant #7): in `mode`, or
     * every perspective. `exceptHeadSha` spares rows already at that head —
     * PollScheduler's "the head moved" sweep must not retire a run the user
     * started at the new head before the poll saw it.
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
    const diffCacheService = yield* DiffCacheService;
    const snapshotImporter = yield* WalkthroughSnapshotImporter;
    const realtime = yield* Realtime;
    const stackService = yield* StackService;

    // Every decision about a PR's rows — a request, a resume, a hydrate —
    // runs under its PR's lock, so two of them can't both find the head free.
    const prLocks = yield* makeStartJobMutex();
    const underPrLock = <A, E>(prId: string, effect: Effect.Effect<A, E>) =>
      Effect.flatMap(prLocks.acquire(prId), (lock) => lock.withPermits(1)(effect));

    const readRow = (walkthroughId: string) =>
      dbTry("read walkthrough", () => loadWalkthroughRow(db, walkthroughId));

    /** Where a walkthrough's events go: the live run's account, or the PR's owner. */
    const targetOf = (
      walkthroughId: string,
    ): Effect.Effect<{
      readonly prId: string;
      readonly send: (msg: ServerEventMessage) => Effect.Effect<void>;
    } | null> =>
      Effect.gen(function* () {
        const run = yield* jobs.running(walkthroughId);
        if (run) {
          const { prId, accountId } = run.context;
          return { prId, send: (msg) => realtime.toAccount(accountId, msg) };
        }
        // No live run: a settle after the run ended, or a chat edit on a
        // completed walkthrough (invariant #7's carve-out).
        const row = yield* readRow(walkthroughId).pipe(
          // Best effort: clients reconcile from the DB (invariant #8).
          Effect.orElseSucceed(() => null),
        );
        if (!row) return null;
        const prId = row.pullRequestId;
        return { prId, send: (msg) => realtime.toPr(prId, msg) };
      });

    const emitEvent = (walkthroughId: string, event: WalkthroughStreamEvent): Effect.Effect<void> =>
      Effect.withSpan(SPAN.walkthroughEmitEvent, {
        attributes: { [SPAN_ATTR.walkthroughId]: walkthroughId, eventType: event.type },
      })(
        Effect.gen(function* () {
          const target = yield* targetOf(walkthroughId);
          if (target === null) {
            debug("wt-trace", `emitEvent-no-target wt=${walkthroughId} type=${event.type}`);
            return;
          }
          const { prId, send } = target;
          if (isWalkthroughLiveEvent(event)) {
            return yield* send({ type: "walkthrough:live", data: { prId, walkthroughId, event } });
          }
          // The seq is bumped in the DB, so it survives kill -9, resumes and
          // chat edits after completion. An event whose seq didn't commit isn't
          // sent; clients reconcile from the DB.
          const seq = yield* walkthroughService.bumpSeq(walkthroughId).pipe(
            Effect.catchTag("DbError", (err) =>
              Effect.sync(() => {
                logError("walkthrough-jobs", `emitEvent ${event.type} not sequenced:`, err.message);
                return null;
              }),
            ),
          );
          if (seq === null) return;
          yield* send({ type: "walkthrough:event", data: { prId, walkthroughId, seq, event } });
        }),
      );

    const lifecycle = makeWalkthroughLifecycle({
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

    const jobs = yield* makeAgentJobs<WalkthroughRunContext, WalkthroughFailure>({
      name: "walkthrough-jobs",
      concurrency: MAX_CONCURRENT_JOBS,
      turnsPerRun: 1 + MAX_AUTO_CONTINUATIONS,
      journal: {
        generating: Effect.map(walkthroughService.listGenerating(), (rows) =>
          rows.map((row) => row.id),
        ),
        bumpResumeAttempts: (walkthroughId) =>
          walkthroughService.incrementResumeAttempts(walkthroughId),
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
      relaunch: (walkthroughId) => resumeRow(walkthroughId, { revive: false }),
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
          if (clone.status === "error") {
            return {
              kind: "failed" as const,
              failure: cloneFailure({ kind: "failed", error: clone.error }),
            };
          }
          if (Date.now() > deadline) {
            return { kind: "failed" as const, failure: cloneFailure({ kind: "slow" }) };
          }
          // A heartbeat for the client's stall watchdog.
          if (poll % 15 === 0) yield* waiting;
          yield* Effect.sleep(CLONE_POLL_MS);
        }
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

    /**
     * Run a `generating` row as its journal records it. The launch is planned
     * and recorded first if the row has none: `jobStart` (when given) asks the
     * job-start judgment to size it.
     */
    const launchRow = (input: {
      readonly row: WalkthroughRow;
      readonly context: PrContextBasic;
      readonly files: ReadonlyArray<PromptFile>;
      readonly trigger: WalkthroughStartTrigger;
      readonly cloneInProgress: boolean;
      readonly resumed: boolean;
      readonly jobStart: JobStartStateInput | null;
    }): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const { row, context } = input;
        const { pr, repo, accountId } = context;
        const walkthroughId = row.id;

        let plan = row.launchPlan;
        // A confidence marks the tier as the orchestrator's; without one it is the agent's to judge.
        let assignedRisk = row.riskConfidence !== null ? (row.riskLevel as RiskLevel) : null;
        if (plan === null) {
          const settings = yield* settingsService.getSettings();
          const planned = yield* planLaunch({
            prId: pr.id,
            headSha: row.prHeadSha,
            state: input.jobStart,
            settings,
            agent: yield* settingsService.resolveAgent(),
          }).pipe(
            Effect.provideService(JevService, jevService),
            Effect.provideService(CacheService, cacheService),
          );
          yield* walkthroughService.recordLaunch(
            walkthroughId,
            planned.plan,
            providerConfigFor(planned.plan, settings.aiMaxTurns),
            planned.risk,
          );
          plan = planned.plan;
          assignedRisk = planned.risk?.level ?? assignedRisk;
        }
        const generationMode: WalkthroughGenerationMode =
          row.generationMode === "incremental" ? "incremental" : "full";
        const parentFingerprint = yield* parentFingerprintOf(
          row.stackContext,
          generationMode,
          row.parentWalkthroughId,
        ).pipe(Effect.provideService(WalkthroughService, walkthroughService));

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
            ),
          );

        // Before the fork, so it precedes every event of the run.
        yield* emitEvent(walkthroughId, {
          type: "lifecycle:started",
          data: {
            walkthroughId,
            prHeadSha: row.prHeadSha,
            mode: row.mode,
            trigger: input.trigger,
            ...(assignedRisk !== null ? { riskLevel: assignedRisk } : {}),
            modelUsed: plan.model,
          },
        });

        const inputs: WalkthroughRunInputs = {
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
          token: context.client.token,
          files: input.files,
          generationMode,
          parentWalkthroughId: row.parentWalkthroughId,
          baseHeadSha: row.baseHeadSha,
          resumed: input.resumed,
          plan,
          assignedRisk,
          stack: row.stackContext,
          parentFingerprint,
        };
        yield* jobs.launch({
          id: walkthroughId,
          context: () =>
            makeWalkthroughRunContext({
              db,
              walkthroughId,
              prId: pr.id,
              accountId,
              mode: row.mode,
              prHeadSha: row.prHeadSha,
              emit: emitNow,
              broadcastThreadEvent: (msg) => void runPromise(realtime.toAccount(accountId, msg)),
              runJudgment,
            }),
          ...(input.cloneInProgress ? { queue: () => awaitClone(repo.id, walkthroughId) } : {}),
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
              Effect.annotateLogs({ walkthroughId, prId: pr.id }),
              // The forked work's real duration: the walkthrough-gen-duration KPI.
              Effect.withSpan(SPAN.walkthroughGenerate, {
                attributes: {
                  [SPAN_ATTR.walkthroughId]: walkthroughId,
                  [SPAN_ATTR.prId]: pr.id,
                  [SPAN_ATTR.trigger]: input.trigger,
                  [SPAN_ATTR.model]: plan.model,
                },
              }),
              withGitHubOrigin("walkthrough:job"),
            ),
        });
      });

    /** The finished review a new row at `headSha` can take over, if any. */
    const findCarry = (input: {
      readonly restack: RestackCarry | null;
      readonly repoFullName: string;
      readonly headSha: string;
      readonly mode: WalkthroughMode;
    }): Effect.Effect<Carry | null> =>
      Effect.gen(function* () {
        const { restack } = input;
        if (restack !== null) {
          const snapshot = yield* Effect.try({
            try: () =>
              exportWalkthroughSnapshot(db, {
                walkthroughId: restack.fromWalkthroughId,
                repoFullName: input.repoFullName,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) =>
              Effect.sync(() => {
                logError(
                  "walkthrough-jobs",
                  `restack export of ${restack.fromWalkthroughId} failed — trying the team cache:`,
                  cause,
                );
                return Option.none<WalkthroughSnapshotV2>();
              }),
            ),
          );
          if (Option.isSome(snapshot)) {
            return {
              snapshot: snapshot.value,
              source: "restack",
              fromWalkthroughId: restack.fromWalkthroughId,
            };
          }
        }
        const snapshot = yield* remoteCache.fetch(input.repoFullName, input.headSha, input.mode);
        return Option.isSome(snapshot) ? { snapshot: snapshot.value, source: "remote" } : null;
      });

    /** Import a carried review into the new row and complete it, or false to fall through. */
    const takeOver = (walkthroughId: string, carry: Carry): Effect.Effect<boolean, DbError> =>
      Effect.gen(function* () {
        const imported = yield* snapshotImporter
          .import({ walkthroughId, snapshot: carry.snapshot })
          .pipe(Effect.result);
        if (imported._tag === "Failure") {
          logError(
            "walkthrough-jobs",
            `${carry.source} import failed wt=${walkthroughId}: ${imported.failure.reason}`,
          );
          return false;
        }
        if (carry.fromWalkthroughId !== undefined) {
          yield* walkthroughService.markCarriedFrom(walkthroughId, carry.fromWalkthroughId);
        }
        yield* lifecycle.complete(walkthroughId, ZERO_TOKEN_USAGE, carry.source);
        return true;
      });

    const request = (params: StartJobParams): Effect.Effect<StartJobResult, StartJobError> =>
      Effect.gen(function* () {
        const mode = params.mode ?? "reviewer";
        const requestedGenerationMode = params.generationMode ?? "full";
        const live = yield* findActiveByPr(params.prId, mode);

        const resolved = yield* prContextService.withDiff(params.prId);
        const { pr, repo, meta, files, commits } = resolved;
        const headSha = meta.headSha;
        const pinnedHead = params.expectedHeadSha?.toLowerCase();
        if (pinnedHead !== undefined && headSha.toLowerCase() !== pinnedHead) {
          return yield* Effect.fail(
            new HeadShaMismatchError({ expectedHeadSha: pinnedHead, githubHeadSha: headSha }),
          );
        }

        if (live !== null) {
          if (live.prHeadSha !== headSha) {
            // The PR moved past the live run's head: it is stale (invariant #7).
            yield* supersedeForPr(pr.id, headSha, mode);
          } else if (params.replace !== "all") {
            return { walkthroughId: live.walkthroughId, reused: true };
          }
        }

        // A run waits for a clone in progress.
        const clone = yield* repoCloneService.getCloneStatus(repo.id);
        if (clone.status === "error" || clone.status === "pending") {
          const { message } = cloneFailure(
            clone.status === "error" ? { kind: "failed", error: clone.error } : { kind: "missing" },
          );
          return yield* Effect.fail(new AiGenerationError({ cause: clone, message }));
        }
        const cloneInProgress = clone.status === "cloning";
        const launch = (row: WalkthroughRow, resumed: boolean) =>
          launchRow({
            row,
            context: resolved,
            files,
            trigger: params.trigger,
            cloneInProgress,
            resumed,
            jobStart: { pr, files },
          });

        // After the clone check, so a request that can't start leaves the
        // reviews it would replace standing.
        if (params.replace === "all") {
          yield* supersedeForPr(pr.id);
        } else {
          if (pinnedHead !== undefined) yield* supersedeForPr(pr.id, headSha, mode);
          // One perspective at a time. Both write their AI threads into the
          // PR's one review, so Submit would post both walkthroughs' comments.
          if (params.replace === "finished") {
            yield* supersedeForPr(pr.id, undefined, otherWalkthroughMode(mode));
          }
          const atHead = yield* walkthroughService.activeAt(
            pr.id,
            headSha,
            mode,
            requestedGenerationMode,
          );
          if (atHead?.status === "generating") {
            // Its run died before anything resumed it: run it again.
            const row = yield* readRow(atHead.id);
            if (row) {
              yield* launch(row, true);
              return { walkthroughId: row.id, reused: false };
            }
          } else if (atHead !== null && params.replace === "none") {
            return { walkthroughId: atHead.id, reused: true };
          }
        }

        const newRow = yield* planNewRow({
          prId: pr.id,
          headSha,
          files,
          mode,
          requestedGenerationMode,
          snapshotStack: stackService.snapshot(resolved),
        }).pipe(Effect.provideService(WalkthroughService, walkthroughService));
        const carry = yield* findCarry({
          restack: newRow.restack,
          repoFullName: repo.fullName,
          headSha,
          mode,
        });
        // Only the orchestrator creates walkthrough rows; MCP handlers only
        // update them.
        const walkthroughId = yield* walkthroughService.createRow({
          reviewSessionId: yield* reviewService.sessionIdFor(pr.id),
          prId: pr.id,
          prHeadSha: headSha,
          mode,
          generationMode: newRow.generationMode,
          parentWalkthroughId: newRow.parentWalkthroughId,
          baseHeadSha: newRow.baseHeadSha,
          prCommits: commits,
          generatedBy: generatedByOf(db, { ...repo, accountId: resolved.accountId }) ?? null,
          stackContext: newRow.stack,
          diffFingerprint: newRow.diffFingerprint,
        });
        if (carry !== null && (yield* takeOver(walkthroughId, carry))) {
          return { walkthroughId, reused: false };
        }
        const row = yield* readRow(walkthroughId);
        if (row) yield* launch(row, false);
        return { walkthroughId, reused: false };
      });

    const importFromTeamCache = (prId: string, mode: WalkthroughMode): Effect.Effect<boolean> =>
      underPrLock(
        prId,
        Effect.gen(function* () {
          const context = yield* prContextService.forPr(prId);
          const { pr, repo } = context;
          const headSha = pr.headSha;
          if (headSha === null) return false;
          // Settled under the lock: a request may have created one since `/current` looked.
          for (const generationMode of ["full", "incremental"] as const) {
            if (yield* walkthroughService.activeAt(pr.id, headSha, mode, generationMode)) {
              return false;
            }
          }
          const carry = yield* findCarry({
            restack: null,
            repoFullName: repo.fullName,
            headSha,
            mode,
          });
          if (carry === null) return false;
          const walkthroughId = yield* walkthroughService.createRow({
            reviewSessionId: yield* reviewService.sessionIdFor(pr.id),
            prId: pr.id,
            prHeadSha: headSha,
            mode,
            generationMode: "full",
            parentWalkthroughId: null,
            baseHeadSha: null,
          });
          if (yield* takeOver(walkthroughId, carry)) return true;
          yield* lifecycle.fail(walkthroughId, IMPORT_FAILED);
          return false;
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logError(
              "walkthrough-jobs",
              `team-cache hydrate of ${prId} failed:`,
              Cause.pretty(cause),
            );
            return false;
          }),
        ),
      );

    /** Back to `generating` with the launch re-resolved from today's settings; false when the row isn't in `error`. */
    const revive = (row: WalkthroughRow): Effect.Effect<boolean, DbError> =>
      Effect.gen(function* () {
        if (!(yield* walkthroughService.revive(row.id))) return false;
        if (!row.launchPlan) return true;
        const settings = yield* settingsService.getSettings();
        const agent = yield* settingsService.resolveAgent();
        const plan = {
          ...row.launchPlan,
          ...launchFor(settings, agent, row.launchPlan.sizing),
        };
        yield* walkthroughService.recordLaunch(
          row.id,
          plan,
          providerConfigFor(plan, settings.aiMaxTurns),
        );
        return true;
      });

    /**
     * Run an existing row again, from its journal alone: no GitHub call but
     * the diff at its head when none is cached. A boot resume (`revive`
     * false) only takes `generating` rows; the user's Resume revives an
     * errored one first.
     */
    const resumeRow = (
      walkthroughId: string,
      options: { readonly revive: boolean },
    ): Effect.Effect<ResumeOutcome, ResumeError> =>
      Effect.gen(function* () {
        const found = yield* readRow(walkthroughId);
        if (!found) return "gone";
        return yield* underPrLock(
          found.pullRequestId,
          Effect.gen(function* () {
            if (yield* jobs.running(walkthroughId)) return "resumed";
            const row = yield* readRow(walkthroughId);
            const resumable =
              row?.status === "generating" || (options.revive && row?.status === "error");
            if (!row || !resumable) return "gone";

            const context = yield* prContextService.forPr(row.pullRequestId);
            const { pr, repo, client } = context;
            if (pr.headSha !== null && pr.headSha !== row.prHeadSha) {
              // The PR has moved on since this row's run (invariant #7).
              yield* supersedeForPr(pr.id, pr.headSha, row.mode);
              return "superseded";
            }
            if (row.status === "error" && !(yield* revive(row))) return "gone";
            const current = (yield* readRow(walkthroughId)) ?? row;

            const { files } = yield* diffCacheService.getOrFetch(pr, repo.fullName, client);
            // A clone cut off by the restart comes back `pending`; one that
            // failed ends the run through the same wait.
            const clone = yield* repoCloneService.getCloneStatus(repo.id);
            yield* launchRow({
              row: current,
              context,
              files: toGitHubFileShape(files),
              trigger: "resume",
              cloneInProgress: clone.status !== "ready",
              resumed: true,
              // Sized by the job-start judgment only while nothing is written:
              // the tier it assigns would overwrite the one the agent set.
              jobStart:
                current.lastCompletedPhase === "none"
                  ? { pr, files: toGitHubFileShape(files) }
                  : null,
            });
            return "resumed";
          }),
        );
      });

    return {
      startJob: (params) => underPrLock(params.prId, request(params)),
      importFromTeamCache,
      resume: (walkthroughId) => resumeRow(walkthroughId, { revive: true }),
      findActiveByPr,
      cancel: (walkthroughId) => jobs.stop(walkthroughId, "user"),
      resumePending: () => jobs.resumePending,
      supersedeForPr,
      emitEvent,
      resolveSessionToken: jobs.resolveToken,
    };
  }),
);
