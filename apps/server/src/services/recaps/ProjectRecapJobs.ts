// Daily / weekly project recaps on the durable agent-job kernel
// (`jobs/agent-jobs.ts`), which owns the run lifecycle, the resume budget and
// the MCP token. What is recap-specific lives here:
//
//   • `requestRecap` owns the create / reuse / rerun decision for a window
//     (one active recap per (repoId, period, periodStart)), serialized per
//     window.
//   • A run assembles the window's source bundle once and records it on the
//     row, so a resumed run reads the same pull requests its earlier attempt
//     was writing entries for.
//
// Agents never write `status` (invariants 2 and 11). Content
// writes go through the recap MCP tool handlers in `ai/providers/recap-tools/`.

import type {
  ProjectRecap,
  ProjectRecapStatus,
  RecapPeriod,
  RecapStreamEvent,
  RecapWindowBounds,
} from "@revv/shared";
import { rollingWindow } from "@revv/shared";
import { SPAN, SPAN_ATTR } from "@revv/shared/telemetry";
import { Context, Effect, Layer } from "effect";
import { runRecapAgentViaAcp } from "../../ai/providers/recap-acp";
import { type RecapToolContext, recapCompletionBlocker } from "../../ai/providers/recap-tools";
import type { DbError, RecapNotFoundError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { debug } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { withTraceAnchor } from "../../observability/span-graft";
import { DbService } from "../Db";
import { DiffCacheService } from "../DiffCache";
import { GitHubGateway } from "../github/gateway";
import { makeStartJobMutex } from "../job-mutex";
import { makeSubscriberRegistry, type SubscriberChannel } from "../job-subscribers";
import {
  type AgentJobs,
  type AgentRun,
  makeAgentJobs,
  type RunEnd,
  type RunOutcome,
} from "../jobs/agent-jobs";
import {
  newToolGate,
  runToolGatedTurn,
  TOOL_GATED_FAILURES,
  type ToolGate,
  toolGateHooks,
} from "../jobs/tool-gated-run";
import { PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import { PullRequestService } from "../PullRequest";
import { Realtime } from "../Realtime";
import { SettingsService } from "../Settings";
import { ProjectRecapService } from "./ProjectRecap";
import { planRecapRequest, type RecapIntent } from "./request";
import { makeRecapSources } from "./source-bundle";

/** Cap on concurrent recap jobs. Lower than walkthroughs — recap calls are heavier per turn. */
export const MAX_CONCURRENT_RECAP_JOBS = 2;

/** A run's live state: its SSE subscribers and what the MCP route hands the tools. */
interface RecapRun extends SubscriberChannel<RecapStreamEvent>, ToolGate {
  /** Set once the source bundle is assembled; the token resolves to nothing before. */
  tools: RecapToolContext | null;
}

export interface RecapRequest {
  readonly repoId: string;
  readonly period: RecapPeriod;
  /** Omitted: the open window, up to now. */
  readonly window?: RecapWindowBounds;
  readonly intent: RecapIntent;
}

export type StartRecapJobError = DbError | RecapNotFoundError;

export type SubscribeResult =
  | {
      readonly found: true;
      readonly unsubscribe: () => void;
      readonly flush: () => void;
    }
  | { readonly found: false };

export class ProjectRecapJobs extends Context.Service<
  ProjectRecapJobs,
  {
    /**
     * Ask for the recap of a window: create it, reuse the one there, or rerun
     * that one in place (see `planRecapRequest`). Null when a scheduled
     * request finds a window with no pull-request activity, which gets no row.
     */
    readonly requestRecap: (
      request: RecapRequest,
    ) => Effect.Effect<{ readonly recapId: string } | null, StartRecapJobError>;

    /**
     * Make sure a `generating` recap has a live run: a no-op while one is live,
     * else the budgeted resume a restart would do.
     */
    readonly attach: (recapId: string) => Effect.Effect<void>;

    /** The user's Stop. Settles a row whose run already died, too. */
    readonly cancel: (recapId: string) => Effect.Effect<void>;

    readonly resumePending: () => Effect.Effect<void>;

    /**
     * Subscribe to live events for a generating recap. Buffered mode so
     * events arriving before flush are replayed in order.
     */
    readonly subscribe: (
      recapId: string,
      onEvent: (event: RecapStreamEvent) => void,
    ) => Effect.Effect<SubscribeResult>;

    readonly resolveSessionToken: (token: string) => Effect.Effect<RecapToolContext | null>;
  }
>()("ProjectRecapJobs") {}

export const ProjectRecapJobsLive = Layer.effect(
  ProjectRecapJobs,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const realtime = yield* Realtime;
    const recapService = yield* ProjectRecapService;
    const prService = yield* PullRequestService;
    const prCtx = yield* PrContextService;
    const settingsService = yield* SettingsService;
    const diffCache = yield* DiffCacheService;
    const github = yield* GitHubGateway;
    const mirror = yield* PrMirror;

    const sources = makeRecapSources({
      prs: prService,
      prContext: prCtx,
      diffCache,
      github,
      mirror,
    });
    const windowMutex = yield* makeStartJobMutex();
    const subscribers = makeSubscriberRegistry<RecapStreamEvent>({
      traceScope: "recap-jobs",
      errorScope: "recap-jobs",
      idLabel: "recap",
      handleIdPrefix: "",
    });

    const terminalEvent = (recapId: string, outcome: RunOutcome<string>): RecapStreamEvent =>
      outcome.kind === "complete"
        ? { type: "done", data: { recapId } }
        : outcome.kind === "stopped"
          ? { type: "stopped", data: { recapId } }
          : { type: "error", data: { code: "RecapGenerationError", message: outcome.failure } };

    const settle = (
      recapId: string,
      outcome: RunOutcome<string>,
      run: AgentRun<RecapRun> | null,
    ): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const status: ProjectRecapStatus =
          outcome.kind === "failed" ? "error" : outcome.kind === "stopped" ? "stopped" : "complete";
        const moved = yield* recapService.finish(recapId, status, {
          ...(run?.context.modelUsed ? { modelUsed: run.context.modelUsed } : {}),
          ...(outcome.kind === "failed" ? { errorMessage: outcome.failure } : {}),
        });
        if (run) subscribers.fanOut(recapId, run.context, terminalEvent(recapId, outcome));
        if (!moved) return;
        const fresh = yield* recapService
          .getById(recapId)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fresh) return;
        // completedAt and errorMessage go out even when null, so a client
        // cache drops the values of an earlier status.
        yield* realtime.toRepo(fresh.repositoryId, {
          type: "recap:status-changed",
          data: {
            recapId,
            repoId: fresh.repositoryId,
            period: fresh.period,
            status,
            completedAt: fresh.completedAt,
            errorMessage: fresh.errorMessage,
          },
        });
        if (status === "complete") {
          yield* realtime.toRepo(fresh.repositoryId, {
            type: "recap:added",
            data: { recap: fresh },
          });
        }
      });

    const jobs: AgentJobs<RecapRun, string> = yield* makeAgentJobs<RecapRun, string>({
      name: "recap-jobs",
      concurrency: MAX_CONCURRENT_RECAP_JOBS,
      turnsPerRun: 1,
      journal: {
        generating: Effect.map(recapService.listGenerating(), (rows) => rows.map((row) => row.id)),
        bumpResumeAttempts: (recapId) => recapService.incrementResumeAttempts(recapId),
        completionBlocker: (recapId) =>
          dbTry("recap completion check", () => recapCompletionBlocker(db, recapId)),
      },
      settle,
      ...TOOL_GATED_FAILURES,
      relaunch: (recapId) => launch(recapId),
    });

    const runRecap = (run: AgentRun<RecapRun>): Effect.Effect<RunEnd<string>, DbError> =>
      Effect.gen(function* () {
        // Time to the first nonempty reasoning token; synthetic phase and
        // activity events don't show the model has responded.
        let agentStartMs: number | null = null;
        let ttftMs: number | null = null;
        const emit = (event: RecapStreamEvent): void => {
          if (
            agentStartMs !== null &&
            ttftMs === null &&
            event.type === "thought" &&
            event.data.text.length > 0
          ) {
            ttftMs = Date.now() - agentStartMs;
          }
          subscribers.fanOut(run.id, run.context, event);
        };
        const recap = yield* recapService
          .getById(run.id)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!recap) return { kind: "failed", failure: "Recap row not found" };
        const repo = yield* prCtx
          .getRepo(recap.repositoryId)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!repo) {
          return { kind: "failed", failure: "Repository not found — cannot build source bundle" };
        }

        const assembled =
          (yield* recapService.getSourceBundle(run.id)) ??
          (yield* sources
            .assemble(recap, repo.fullName)
            .pipe(
              Effect.tap((bundle) =>
                typeof bundle === "string"
                  ? Effect.void
                  : recapService.saveSourceBundle(run.id, bundle),
              ),
            ));
        if (assembled === "nothing-yet") {
          // A live window: "come back later" is the answer, and the page's
          // Generate copy assumes it.
          return { kind: "failed", failure: "No archived or open PRs found for this window" };
        }
        if (assembled === "empty") {
          // A closed window: "nothing shipped" is final, not a failure, and
          // costs no tokens.
          debug("recap-jobs", `empty historical window for recap ${run.id} — no agent run`);
          yield* recapService.markEmptyWindow(run.id);
          return { kind: "complete" };
        }

        const priorRecaps: ReadonlyArray<ProjectRecap> = yield* recapService
          .getLatestForRepo(recap.repositoryId, { limit: 5 })
          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ProjectRecap>)));

        const repoClient = yield* Effect.cached(sources.repoClient(recap.repositoryId));
        const runContext = yield* Effect.context<never>();
        const tools: RecapToolContext = {
          db,
          recapId: run.id,
          sourceBundle: assembled,
          priorRecaps,
          getPrDiff: (prId) =>
            prService.getPr(prId).pipe(
              Effect.flatMap((pr) =>
                Effect.flatMap(repoClient, (client) => sources.loadDiff(pr, repo.fullName, client)),
              ),
              Effect.catch(() => Effect.succeed(null)),
              Effect.provide(runContext),
            ),
          emit,
          ...toolGateHooks(run.context),
        };
        run.context.tools = tools;

        const end = yield* runToolGatedTurn({
          run,
          purpose: "recap",
          clonePath: repo.clonePath,
          turn: (agent) => {
            emit({
              type: "phase",
              data: { phase: "analyzing", message: "Analyzing pull requests…" },
            });
            agentStartMs = Date.now();
            return runRecapAgentViaAcp({
              ctx: tools,
              sessionToken: run.token,
              abortController: run.abort,
              activity: run.activity,
              ...agent,
            });
          },
          unfinished:
            "Agent finished without calling complete_recap — the overview may be empty or invalid",
        }).pipe(Effect.provideService(SettingsService, settingsService));
        if (ttftMs !== null) yield* Effect.annotateCurrentSpan(SPAN_ATTR.ttftMs, ttftMs);
        return end;
      });

    const launch = (recapId: string): Effect.Effect<void> =>
      jobs
        .launch({
          id: recapId,
          context: (): RecapRun => ({
            ...newToolGate(),
            subscribers: new Set(),
            nextSeq: 0,
            tools: null,
          }),
          body: runRecap,
          instrument: (_run, effect) =>
            effect.pipe(
              // Before the span, so the anchor resolves to it.
              withTraceAnchor(recapId),
              Effect.annotateLogs({ recapId }),
              Effect.withSpan(SPAN.recapGenerate, { attributes: { [SPAN_ATTR.recapId]: recapId } }),
              withGitHubOrigin("recap:job"),
            ),
        })
        .pipe(Effect.asVoid);

    const requestRecap = (
      request: RecapRequest,
    ): Effect.Effect<{ readonly recapId: string } | null, StartRecapJobError> =>
      Effect.gen(function* () {
        const now = new Date();
        const window = request.window ?? rollingWindow(request.period, now);
        const { repoId, period } = request;
        const mutex = yield* windowMutex.acquire(`${repoId}:${period}:${window.periodStart}`);
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* recapService
              .findActiveForPeriod(repoId, period, window.periodStart)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            const plan = planRecapRequest({
              intent: request.intent,
              period,
              window,
              rolling: request.window === undefined,
              existing,
              now,
            });

            if (existing && plan === "reuse") {
              if (existing.status === "generating") yield* jobs.resume(existing.id);
              return { recapId: existing.id };
            }

            if (existing && plan === "rerun") {
              yield* jobs.stop(existing.id, "user");
              yield* recapService.resetForRerun(existing.id, window);
              const refreshed = yield* recapService
                .getById(existing.id)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              if (refreshed) {
                yield* realtime.toRepo(repoId, {
                  type: "recap:added",
                  data: { recap: refreshed },
                });
              }
              yield* launch(existing.id);
              return { recapId: existing.id };
            }

            // A quiet window the user didn't ask for leaves a gap in the
            // list rather than a "nothing to report" recap.
            if (request.intent === "scheduled" && (yield* sources.windowIsSilent(repoId, window))) {
              return null;
            }
            const created = yield* recapService.createPartial({
              repositoryId: repoId,
              period,
              ...window,
            });
            yield* realtime.toRepo(repoId, {
              type: "recap:added",
              data: { recap: created },
            });
            yield* launch(created.id);
            return { recapId: created.id };
          }),
        );
      });

    const subscribe = (
      recapId: string,
      onEvent: (event: RecapStreamEvent) => void,
    ): Effect.Effect<SubscribeResult> =>
      Effect.map(jobs.running(recapId), (run): SubscribeResult => {
        if (!run) return { found: false };
        const { unsubscribe, flush } = subscribers.subscribe(recapId, run.context, onEvent);
        return { found: true, unsubscribe, flush };
      });

    return {
      requestRecap,
      attach: jobs.resume,
      cancel: (recapId) => jobs.stop(recapId, "user"),
      resumePending: () => jobs.resumePending,
      subscribe,
      resolveSessionToken: (token) =>
        Effect.map(jobs.resolveToken(token), (run) => run?.context.tools ?? null),
    };
  }),
);
