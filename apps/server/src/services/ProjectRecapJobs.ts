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
import { rollingWindow, windowIsCurrent } from "@revv/shared";
import { SPAN } from "@revv/shared/telemetry";
import { sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import { resolveAgentLaunch } from "../ai/acp/agent-launch";
import { isAgentLaunchable } from "../ai/acp/launch";
import { runRecapAgentViaAcp } from "../ai/providers/recap-acp";
import {
  type RecapSourcePrDiff,
  type RecapSourcePrDiffFile,
  type RecapToolContext,
  recapCompletionBlocker,
} from "../ai/providers/recap-tools";
import { recapPrDigests } from "../db/schema/index";
import type { RecapSourceBundle, RecapSourcePrDigest } from "../db/schema/project-recaps";
import type { DbError, RecapNotFoundError } from "../domain/errors";
import type { ObservedPr } from "../domain/observed-pr";
import { dbTry } from "../effects/db-try";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { withGitHubOrigin } from "../observability/github-ledger/origin";
import { withTraceAnchor } from "../observability/span-graft";
import { DbService } from "./Db";
import { DiffCacheService } from "./DiffCache";
import { GitHubGateway } from "./github/gateway";
import type { GitHubClient } from "./github/transport";
import { makeStartJobMutex } from "./job-mutex";
import { makeSubscriberRegistry, type SubscriberChannel } from "./job-subscribers";
import {
  type AgentJobs,
  type AgentRun,
  MAX_RESUME_ATTEMPTS,
  makeAgentJobs,
  type RunEnd,
  type RunOutcome,
} from "./jobs/agent-jobs";
import { PrContextService } from "./PrContext";
import { PrMirror } from "./PrMirror";
import { ProjectRecapService } from "./ProjectRecap";
import { type ArchivedPrWithWalkthrough, PullRequestService } from "./PullRequest";
import { Realtime } from "./Realtime";
import { planRecapRequest, type RecapIntent } from "./recap-request";
import {
  attachRecapDigests,
  buildDigestForRecapPr,
  buildSourceBundle,
  RECAP_DIFF_MAX_FILES_PER_PR,
  RECAP_DIFF_MAX_PATCH_CHARS,
  truncatePatch,
} from "./recap-source-bundle";
import { SettingsService } from "./Settings";

/** Cap on concurrent recap jobs. Lower than walkthroughs — recap calls are heavier per turn. */
export const MAX_CONCURRENT_RECAP_JOBS = 2;

/** A run's live state: its SSE subscribers and what the MCP route hands the tools. */
interface RecapRun extends SubscriberChannel<RecapStreamEvent> {
  /** Set once the source bundle is assembled; the token resolves to nothing before. */
  tools: RecapToolContext | null;
  calledAnyTool: boolean;
  validated: boolean;
  modelUsed: string | null;
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

    const windowMutex = yield* makeStartJobMutex();
    const subscribers = makeSubscriberRegistry<RecapStreamEvent>({
      traceScope: "recap-jobs",
      errorScope: "recap-jobs",
      idLabel: "recap",
      handleIdPrefix: "",
    });

    const provideDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
      withDb(db, eff);

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
        const moved = yield* provideDb(
          recapService.finish(recapId, status, {
            ...(run?.context.modelUsed ? { modelUsed: run.context.modelUsed } : {}),
            ...(outcome.kind === "failed" ? { errorMessage: outcome.failure } : {}),
          }),
        );
        if (run) subscribers.fanOut(recapId, run.context, terminalEvent(recapId, outcome));
        if (!moved) return;
        const fresh = yield* provideDb(recapService.getById(recapId)).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
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
        generating: Effect.map(provideDb(recapService.listGenerating()), (rows) =>
          rows.map((row) => row.id),
        ),
        bumpResumeAttempts: (recapId) => provideDb(recapService.incrementResumeAttempts(recapId)),
        completionBlocker: (recapId) =>
          dbTry("recap completion check", () => recapCompletionBlocker(db, recapId)),
      },
      settle,
      crashed: (cause) => `Generation failed unexpectedly: ${Cause.pretty(cause).slice(0, 200)}`,
      resumeExhausted: `Exceeded max resume attempts (${MAX_RESUME_ATTEMPTS}) after repeated crashes`,
      relaunch: (recapId) => launch(recapId),
    });

    // Archived PRs without a complete walkthrough surface their actual change
    // so the recap agent can describe it instead of guessing from the title
    // and +/- counts, capped per file and per PR so one PR can't blow up the
    // agent's context window.

    /** The repo owner's client, or null: the recap then reads diffs from the cache only. */
    const resolveRepoClient = (repoId: string): Effect.Effect<GitHubClient | null> =>
      prCtx.forRepo(repoId).pipe(
        Effect.map((ctx): GitHubClient | null => ctx.client),
        Effect.catch((err) =>
          Effect.sync(() => {
            debug(
              "recap-jobs",
              `no GitHub client for repo ${repoId} — recap will fall back to cache-only diffs:`,
              err instanceof Error ? err.message : String(err),
            );
            return null;
          }),
        ),
      );

    /** Any failure degrades to a metadata-only PR rather than failing the recap. */
    const loadDiffForPr = (
      pr: ArchivedPrWithWalkthrough["pr"],
      repoFullName: string,
      client: GitHubClient | null,
    ): Effect.Effect<RecapSourcePrDiff | null> =>
      Effect.gen(function* () {
        const unavailable = (note: string): RecapSourcePrDiff => ({
          files: [],
          totalFiles: 0,
          filesTruncated: false,
          source: "unavailable",
          note,
        });

        const loaded =
          client === null
            ? yield* diffCache
                .getCachedFiles(pr.id)
                .pipe(
                  Effect.map((files) =>
                    files === null ? null : { files, source: "cache" as const },
                  ),
                )
            : yield* diffCache.getOrFetch(pr, repoFullName, client);
        if (loaded === null) {
          return unavailable(
            "No diff cached locally and no GitHub token available — describe this PR from title/body/+/- counts only.",
          );
        }

        const totalFiles = loaded.files.length;
        const trimmed = loaded.files.slice(0, RECAP_DIFF_MAX_FILES_PER_PR);
        const filesTruncated = trimmed.length < totalFiles;
        const recapFiles: RecapSourcePrDiffFile[] = trimmed.map((f) => {
          const { patch, truncated } = truncatePatch(f.patch);
          return {
            path: f.path,
            oldPath: f.oldPath,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch,
            patchTruncated: truncated,
          };
        });
        const notes: string[] = [];
        if (filesTruncated) {
          notes.push(
            `Showing ${trimmed.length} of ${totalFiles} files — only the first ${RECAP_DIFF_MAX_FILES_PER_PR} were included.`,
          );
        }
        const truncatedPatchCount = recapFiles.filter((f) => f.patchTruncated).length;
        if (truncatedPatchCount > 0) {
          notes.push(
            `${truncatedPatchCount} patch(es) clipped to ${RECAP_DIFF_MAX_PATCH_CHARS} chars.`,
          );
        }
        return {
          files: recapFiles,
          totalFiles,
          filesTruncated,
          source: loaded.source,
          note: notes.length > 0 ? notes.join(" ") : null,
        } satisfies RecapSourcePrDiff;
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            debug(
              "recap-jobs",
              `diff load failed for pr ${pr.id} (#${pr.externalId}) — recap will skip diff:`,
              err instanceof Error ? err.message : String(err),
            );
            return {
              files: [],
              totalFiles: 0,
              filesTruncated: false,
              source: "unavailable",
              note: "Diff fetch from GitHub failed — describe this PR from title/body/+/- counts only.",
            } satisfies RecapSourcePrDiff;
          }),
        ),
      );

    // The local mirror is populated by the poll scheduler, which only
    // fetches *open* PRs. A PR that closes between two poll cycles or one
    // that closed before the user added the repo never lands in
    // `pull_requests` and therefore never shows up in
    // `listArchivedPrsForWindow`. For a recap whose whole job is "tell me
    // what shipped," that's silent data loss.
    //
    // So before the agent starts, GitHub's issue search fills in what the
    // mirror is missing. Failure is non-fatal: the recap goes ahead on the
    // local mirror.

    /** Cap on per-PR GitHub fetches during one backfill pass — defends
     *  against a misconfigured search returning thousands of PRs. */
    const RECAP_BACKFILL_MAX_FETCHES = 50;

    const backfillMissingPrs = (
      repoId: string,
      repoFullName: string,
      periodStart: string,
      periodEnd: string,
      windowed: ReadonlyArray<ArchivedPrWithWalkthrough>,
    ): Effect.Effect<{ readonly addedCount: number }> =>
      Effect.gen(function* () {
        const client = yield* resolveRepoClient(repoId);
        if (client === null) {
          debug("recap-jobs", `backfill skipped for repo ${repoId} — no GitHub token resolvable`);
          return { addedCount: 0 };
        }

        const searched = yield* github.prs
          .searchClosedInWindow(client, repoFullName, periodStart, periodEnd)
          .pipe(
            Effect.catch((err) =>
              Effect.sync(() => {
                debug(
                  "recap-jobs",
                  `searchClosedPrsInWindow failed for ${repoFullName} — proceeding with local data only:`,
                  err instanceof Error ? err.message : String(err),
                );
                return [] as ReadonlyArray<{
                  readonly number: number;
                  readonly closedAt: string;
                  readonly merged: boolean;
                }>;
              }),
            ),
          );

        if (searched.length === 0) return { addedCount: 0 };

        const knownNumbers = new Set(windowed.map((row) => row.pr.externalId));
        const missing = searched
          .filter((s) => !knownNumbers.has(s.number))
          .slice(0, RECAP_BACKFILL_MAX_FETCHES);

        if (missing.length === 0) return { addedCount: 0 };

        debug(
          "recap-jobs",
          `backfilling ${missing.length} closed PR(s) for ${repoFullName} window ${periodStart}..${periodEnd}`,
        );

        const fetched = yield* github.prs
          .getMany(
            client,
            repoFullName,
            repoId,
            missing.map((m) => m.number),
          )
          .pipe(
            Effect.catch((err) =>
              Effect.sync(() => {
                debug(
                  "recap-jobs",
                  `PR read failed during backfill for ${repoFullName}:`,
                  err instanceof Error ? err.message : String(err),
                );
                return new Map<number, ObservedPr>();
              }),
            ),
          );
        const upsertable = [...fetched.values()];

        if (upsertable.length === 0) return { addedCount: 0 };

        yield* mirror.apply(upsertable).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              logError(
                "recap-jobs",
                `upsertPrs failed during recap backfill for ${repoFullName}:`,
                err instanceof Error ? err.message : String(err),
              );
            }),
          ),
        );

        return { addedCount: upsertable.length };
      });

    /**
     * The window's pull requests, open work and digests. A window with nothing
     * in it is final once closed (`empty`), and "nothing yet" while open.
     */
    const assembleSourceBundle = (
      recap: ProjectRecap,
      repoFullName: string,
    ): Effect.Effect<RecapSourceBundle | "empty" | "nothing-yet", DbError> =>
      Effect.gen(function* () {
        let windowed = yield* provideDb(
          prService.listArchivedPrsForWindow(
            recap.repositoryId,
            recap.periodStart,
            recap.periodEnd,
          ),
        ).pipe(Effect.catch(() => Effect.succeed([] as never[])));

        const backfill = yield* backfillMissingPrs(
          recap.repositoryId,
          repoFullName,
          recap.periodStart,
          recap.periodEnd,
          windowed,
        );
        if (backfill.addedCount > 0) {
          windowed = yield* provideDb(
            prService.listArchivedPrsForWindow(
              recap.repositoryId,
              recap.periodStart,
              recap.periodEnd,
            ),
          ).pipe(Effect.catch(() => Effect.succeed([] as never[])));
        }

        // As of the window's close, so a historical recap doesn't describe
        // today's open PRs. Read before the empty-window check so a window
        // with only open PRs still gets an "active work" recap.
        const openPrs = yield* provideDb(
          prService.listOpenPrsAsOfWindow(recap.repositoryId, recap.periodEnd),
        ).pipe(Effect.catch(() => Effect.succeed([] as never[])));

        if (windowed.length === 0 && openPrs.length === 0) {
          return windowIsCurrent(recap.period, recap.periodStart) ? "nothing-yet" : "empty";
        }

        // Every PR without a completed walkthrough gets its diff compacted
        // into a durable digest, so the agent session scales with many PRs
        // without holding every raw diff.
        const repoClient = yield* Effect.cached(resolveRepoClient(recap.repositoryId));
        const digestEntries = yield* Effect.forEach(
          [...windowed, ...openPrs].filter((row) => row.walkthrough === null),
          (row) =>
            Effect.gen(function* () {
              const diff = yield* loadDiffForPr(row.pr, repoFullName, yield* repoClient).pipe(
                Effect.catch(() => Effect.succeed(null)),
              );
              const digest = buildDigestForRecapPr(row.pr, diff);
              yield* dbTry("persist recap digest", () =>
                db
                  .insert(recapPrDigests)
                  .values({
                    id: `${recap.id}:${row.pr.id}`,
                    recapId: recap.id,
                    prId: row.pr.id,
                    source: digest.source,
                    digest: digest.digest,
                    files: JSON.stringify(digest.files),
                    note: digest.note,
                    generatedAt: new Date().toISOString(),
                  })
                  .onConflictDoUpdate({
                    target: [recapPrDigests.recapId, recapPrDigests.prId],
                    set: {
                      source: sql`excluded.source`,
                      digest: sql`excluded.digest`,
                      files: sql`excluded.files`,
                      note: sql`excluded.note`,
                      generatedAt: sql`excluded.generated_at`,
                    },
                  })
                  .run(),
              ).pipe(
                Effect.catchTag("DbError", (err) =>
                  Effect.sync(() => logError("recap-jobs", err.message)),
                ),
              );
              return [row.pr.id, digest] as const;
            }),
          { concurrency: 3 },
        );

        const bundle = attachRecapDigests(
          buildSourceBundle(
            repoFullName,
            {
              repoId: recap.repositoryId,
              period: recap.period,
              periodStart: recap.periodStart,
              periodEnd: recap.periodEnd,
            },
            windowed,
            openPrs,
          ),
          new Map<string, RecapSourcePrDigest>(digestEntries),
        );
        yield* provideDb(recapService.saveSourceBundle(recap.id, bundle));
        return bundle;
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
        const recap = yield* provideDb(recapService.getById(run.id)).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!recap) return { kind: "failed", failure: "Recap row not found" };
        const repo = yield* provideDb(prCtx.getRepo(recap.repositoryId)).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!repo) {
          return { kind: "failed", failure: "Repository not found — cannot build source bundle" };
        }

        const stored = yield* provideDb(recapService.getSourceBundle(run.id));
        const assembled = stored ?? (yield* assembleSourceBundle(recap, repo.fullName));
        if (assembled === "nothing-yet") {
          // A live window: "come back later" is the answer, and the page's
          // Generate copy assumes it.
          return { kind: "failed", failure: "No archived or open PRs found for this window" };
        }
        if (assembled === "empty") {
          // A closed window: "nothing shipped" is final, not a failure, and
          // costs no tokens.
          debug("recap-jobs", `empty historical window for recap ${run.id} — no agent run`);
          yield* provideDb(recapService.markEmptyWindow(run.id));
          return { kind: "complete" };
        }

        const priorRecaps: ReadonlyArray<ProjectRecap> = yield* provideDb(
          recapService.getLatestForRepo(recap.repositoryId, { limit: 5 }),
        ).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ProjectRecap>)));

        const agentLaunch = yield* resolveAgentLaunch("recap").pipe(
          Effect.provideService(SettingsService, settingsService),
        );
        if (!isAgentLaunchable(agentLaunch.agent)) {
          return {
            kind: "failed",
            failure: `The configured recap agent ('${agentLaunch.agent}') is not available on this machine.`,
          };
        }
        run.context.modelUsed = agentLaunch.model;

        const repoClient = yield* Effect.cached(resolveRepoClient(recap.repositoryId));
        const runContext = yield* Effect.context<never>();
        const tools: RecapToolContext = {
          db,
          recapId: run.id,
          sourceBundle: assembled,
          priorRecaps,
          getPrDiff: (prId) =>
            provideDb(prService.getPr(prId)).pipe(
              Effect.flatMap((pr) =>
                Effect.flatMap(repoClient, (client) => loadDiffForPr(pr, repo.fullName, client)),
              ),
              Effect.catch(() => Effect.succeed(null)),
              Effect.provide(runContext),
            ),
          emit,
          onToolCall: () => {
            run.context.calledAnyTool = true;
          },
          onCompleted: () => {
            run.context.validated = true;
            if (!run.abort.signal.aborted) run.abort.abort(new Error("Recap completed"));
          },
        };
        run.context.tools = tools;

        emit({ type: "phase", data: { phase: "analyzing", message: "Analyzing pull requests…" } });

        agentStartMs = Date.now();
        const outcome = yield* Effect.promise(() =>
          runRecapAgentViaAcp({
            ctx: tools,
            sessionToken: run.token,
            launch: agentLaunch,
            workingDir: repo.clonePath ?? process.cwd(),
            abortController: run.abort,
            activity: run.activity,
            calledAnyTool: () => run.context.calledAnyTool,
            isValidated: () => run.context.validated,
          }),
        );
        if (ttftMs !== null) yield* Effect.annotateCurrentSpan("ttft_ms", ttftMs);

        return {
          kind: "journal",
          failure:
            outcome.error ??
            "Agent finished without calling complete_recap — the overview may be empty or invalid",
        };
      });

    const launch = (recapId: string): Effect.Effect<void> =>
      jobs
        .launch({
          id: recapId,
          context: (): RecapRun => ({
            subscribers: new Set(),
            nextSeq: 0,
            tools: null,
            calledAnyTool: false,
            validated: false,
            modelUsed: null,
          }),
          body: runRecap,
          instrument: (_run, effect) =>
            effect.pipe(
              // Before the span, so the anchor resolves to it.
              withTraceAnchor(recapId),
              Effect.annotateLogs({ recapId }),
              Effect.withSpan(SPAN.recapGenerate, { attributes: { recapId } }),
              withGitHubOrigin("recap:job"),
            ),
        })
        .pipe(Effect.asVoid);

    /**
     * The window has no pull request that closed in it or was open as it
     * closed, as far as the local mirror knows. Same boundary as the run's
     * empty-window check, so the two agree.
     */
    const windowIsSilent = (repoId: string, window: RecapWindowBounds): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const archived = yield* provideDb(
          prService.listArchivedPrsForWindow(repoId, window.periodStart, window.periodEnd),
        ).pipe(Effect.catch(() => Effect.succeed([] as never[])));
        if (archived.length > 0) return false;
        const open = yield* provideDb(
          prService.listOpenPrsAsOfWindow(repoId, window.periodEnd),
        ).pipe(Effect.catch(() => Effect.succeed([] as never[])));
        return open.length === 0;
      });

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
            const existing = yield* provideDb(
              recapService.findActiveForPeriod(repoId, period, window.periodStart),
            ).pipe(Effect.catch(() => Effect.succeed(null)));
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
              yield* provideDb(recapService.resetForRerun(existing.id, window));
              const refreshed = yield* provideDb(recapService.getById(existing.id)).pipe(
                Effect.catch(() => Effect.succeed(null)),
              );
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
            if (request.intent === "scheduled" && (yield* windowIsSilent(repoId, window))) {
              return null;
            }
            const created = yield* provideDb(
              recapService.createPartial({ repositoryId: repoId, period, ...window }),
            );
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
