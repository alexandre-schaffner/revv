// ── ProjectRecapJobs ────────────────────────────────────────────────────────
// Durable orchestrator for daily / weekly project recap generation. Mirrors
// the structure of {@link WalkthroughJobs} but radically simpler:
//
//   • Single-phase MCP-routed pipeline (one atomic write per recap).
//   • No worktrees, no continuations, no SSE streaming. Status-only SSE
//     broadcasts; the recap UI re-fetches the row when needed.
//   • `requestRecap` owns the create / reuse / rerun decision for a window
//     (one active recap per (repoId, period, periodStart)), serialized per
//     window; `startJob` is serialized per recap so attach paths can't fork
//     duplicate fibers.
//   • Bounded retries via `resume_attempts`. Boot resume re-runs the agent
//     from scratch — recap is single-phase so partial state is just the
//     row at `status='generating'` with empty content, which is
//     recoverable by re-running.
//
// Per CLAUDE.md invariants #2 and #11: agents never write `status`. This
// service is the sole writer. Content writes go through the recap MCP tool
// handlers in `ai/providers/recap-tools/`.

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
import { Cause, Context, Effect, type Fiber, Layer, Ref, Semaphore } from "effect";
import { resolveAgentLaunch } from "../ai/acp/agent-launch";
import { isAgentLaunchable } from "../ai/acp/launch";
import { JOB_TURN } from "../ai/acp/run-turn";
import { runRecapAgentViaAcp } from "../ai/providers/recap-acp";
import {
  type RecapSourcePrDiff,
  type RecapSourcePrDiffFile,
  type RecapSourcePrDigest,
  type RecapToolContext,
  recapCompletionBlocker,
} from "../ai/providers/recap-tools";
import { recapPrDigests } from "../db/schema/index";
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
import { analyzeJobFailure } from "./job-failure";
import { makeStartJobMutex } from "./job-mutex";
import { makeSubscriberRegistry, type SubscriberHandle } from "./job-subscribers";
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
import { makeSessionTokenStore } from "./session-token-store";

// ── Constants ────────────────────────────────────────────────────────────────

/** Cap on concurrent recap jobs. Lower than walkthroughs — recap calls are heavier per turn. */
export const MAX_CONCURRENT_RECAP_JOBS = 2;

/** Resume-on-boot retry budget. After this many attempts the row goes to 'error'. */
export const RECAP_MAX_RESUME_ATTEMPTS = 3;

/**
 * TTL for HTTP-MCP session tokens: the turn ceiling, so a token never expires
 * mid-run, plus slack for setup and teardown.
 */
const RECAP_SESSION_TOKEN_TTL_MS = JOB_TURN.ceilingMs + 5 * 60_000;

// ── Types ────────────────────────────────────────────────────────────────────

type Subscriber = (event: RecapStreamEvent) => void;

interface ActiveRecapJob {
  readonly recapId: string;
  readonly repoId: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly abortController: AbortController;
  fiber: Fiber.Fiber<unknown, unknown> | null;
  cancelledByUser: boolean;
  /** Set to true the moment the agent calls `complete_recap` and validation passes. */
  validatedComplete: boolean;
  /** SSE subscribers keyed by opaque handle id. */
  readonly subscribers: Set<SubscriberHandle<RecapStreamEvent>>;
  /** Monotonic seq for tracing (in-memory diagnostic only). */
  nextSeq: number;
}

/** An existing row to run (or attach to, when its job is already running). */
export interface StartRecapJobParams {
  readonly recapId: string;
  readonly repoId: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface RecapRequest {
  readonly repoId: string;
  readonly period: RecapPeriod;
  /** Omitted: the open window, up to now. */
  readonly window?: RecapWindowBounds;
  readonly intent: RecapIntent;
}

export type StartRecapJobError = DbError | RecapNotFoundError;

export type EmitResult =
  | { readonly kind: "delivered"; readonly seq: number }
  | { readonly kind: "skipped-no-job"; readonly recapId: string };

export type SubscribeResult =
  | {
      readonly found: true;
      readonly unsubscribe: () => void;
      readonly flush: () => void;
    }
  | { readonly found: false };

// ── Service tag ──────────────────────────────────────────────────────────────

export class ProjectRecapJobs extends Context.Service<
  ProjectRecapJobs,
  {
    /** Run an existing row's job, or attach to it when it is already running. */
    readonly startJob: (
      params: StartRecapJobParams,
    ) => Effect.Effect<{ readonly recapId: string }, StartRecapJobError>;

    /**
     * Ask for the recap of a window: create it, reuse the one there, or rerun
     * that one in place (see `planRecapRequest`). Null when a scheduled
     * request finds a window with no pull-request activity, which gets no row.
     */
    readonly requestRecap: (
      request: RecapRequest,
    ) => Effect.Effect<{ readonly recapId: string } | null, StartRecapJobError>;

    readonly cancel: (recapId: string) => Effect.Effect<void>;

    /** Re-launch any rows left in `status='generating'` by a prior process. */
    readonly resumePending: () => Effect.Effect<void, DbError>;

    /**
     * Subscribe to live events for a generating recap. Buffered mode so
     * events arriving before flush are replayed in order.
     */
    readonly subscribe: (recapId: string, onEvent: Subscriber) => Effect.Effect<SubscribeResult>;

    /**
     * Fan an event out to a running job's subscribers. No-op if no active job.
     */
    readonly emitEvent: (recapId: string, event: RecapStreamEvent) => Effect.Effect<EmitResult>;

    /**
     * Resolve a `/mcp/recap` bearer token to the per-job tool context it was
     * issued for. Null when the token is unknown or its TTL has elapsed.
     */
    readonly resolveSessionToken: (token: string) => Effect.Effect<RecapToolContext | null>;
  }
>()("ProjectRecapJobs") {}

// ── Live implementation ──────────────────────────────────────────────────────

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

    const registry = yield* Ref.make(new Map<string, ActiveRecapJob>());
    const semaphore = yield* Semaphore.make(MAX_CONCURRENT_RECAP_JOBS);
    const startJobMutex = yield* makeStartJobMutex();

    // Per-job SSE subscriber subscribe/unsubscribe handling. Fan-out stays
    // concrete below while this wave is still mid-refactor.
    const subscribers = makeSubscriberRegistry<RecapStreamEvent>({
      traceScope: "recap-jobs",
      errorScope: "recap-jobs",
      idLabel: "recap",
      handleIdPrefix: "",
    });

    // Ephemeral opencode HTTP-MCP session tokens. Recap passes no liveness
    // predicate — a token resolves to its stored RecapToolContext for as long
    // as it hasn't expired, regardless of fiber liveness (invariant #1).
    const sessionStore = yield* makeSessionTokenStore<RecapToolContext>(RECAP_SESSION_TOKEN_TTL_MS);
    const issueSessionToken = sessionStore.issue;
    const resolveSessionToken = sessionStore.resolve;
    const clearSessionToken = sessionStore.clear;
    const clearTokensForRecap = (recapId: string): Effect.Effect<void> =>
      sessionStore.clearWhere((ctx) => ctx.recapId === recapId);

    const provideDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
      withDb(db, eff);

    // ── Status chokepoint (CLAUDE.md invariant #11) ─────────────────────
    const setStatus = (
      recap: { id: string; repositoryId: string; period: RecapPeriod },
      status: ProjectRecapStatus,
      options?: { tokenUsage?: Record<string, number>; modelUsed?: string; errorMessage?: string },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // A status write that didn't commit must not be broadcast (invariant
        // #8); the row keeps its old status and resume-on-boot picks it up.
        const committed = yield* provideDb(recapService.setStatus(recap.id, status, options)).pipe(
          Effect.as(true),
          Effect.catchTag("DbError", (err) =>
            Effect.sync(() => {
              logError("recap-jobs", `status write ${status} failed for ${recap.id}:`, err.message);
              return false;
            }),
          ),
        );
        if (!committed) return;
        const fresh = yield* provideDb(recapService.getById(recap.id)).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        const data: {
          recapId: string;
          repoId: string;
          period: RecapPeriod;
          status: typeof status;
          completedAt?: string | null;
          errorMessage?: string | null;
        } = {
          recapId: recap.id,
          repoId: recap.repositoryId,
          period: recap.period,
          status,
        };
        // Always send completedAt + errorMessage (including null) so a
        // status transition away from `complete` or `error` clears the
        // stale value on the client cache.
        if (fresh) {
          data.completedAt = fresh.completedAt;
          data.errorMessage = fresh.errorMessage;
        }
        yield* realtime.toRepo(recap.repositoryId, {
          type: "recap:status-changed",
          data,
        });
        // For 'complete', also broadcast the fresh row so the UI can render
        // immediately without re-fetching.
        if (status === "complete" && fresh) {
          yield* realtime.toRepo(recap.repositoryId, {
            type: "recap:added",
            data: { recap: fresh },
          });
        }
      });

    const removeJob = (job: ActiveRecapJob) =>
      Ref.update(registry, (map) => {
        if (map.get(job.recapId) !== job) return map;
        const next = new Map(map);
        next.delete(job.recapId);
        return next;
      });

    // ── Subscriber fan-out ──────────────────────────────────────────────
    // Thin wrapper over the shared `subscribers` registry so the many local
    // `fanOut(job, event)` call sites stay unchanged.
    const fanOut = (job: ActiveRecapJob, event: RecapStreamEvent): number =>
      subscribers.fanOut(job.recapId, job, event);

    // ── Diff loader (walkthrough-fallback path) ─────────────────────────
    //
    // For each archived PR without a complete walkthrough, surface the actual
    // code change so the recap agent can describe it instead of guessing
    // from title + +/- counts. Strategy: cache-then-GitHub, with hard caps
    // on per-file patch size and per-PR file count so a single PR can't
    // blow up the agent's context window.

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

    /**
     * Materialize a {@link RecapSourcePrDiff} for a single PR, from the diff
     * cache or GitHub (written through). Any failure degrades to a
     * metadata-only PR rather than failing the recap.
     */
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

    // ── GitHub backfill for missing closed PRs ──────────────────────────
    //
    // The local mirror is populated by the poll scheduler, which only
    // fetches *open* PRs. A PR that closes between two poll cycles or one
    // that closed before the user added the repo never lands in
    // `pull_requests` and therefore never shows up in
    // `listArchivedPrsForWindow`. For a recap whose whole job is "tell me
    // what shipped," that's silent data loss.
    //
    // Strategy: hit GitHub's issue-search API for the period window,
    // diff against the local DB, and `getPr` + upsert anything we're
    // missing before the recap agent starts. Failure here is non-fatal —
    // we log and continue with whatever the local mirror has.

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

    // ── Job body ─────────────────────────────────────────────────────────

    const buildJobBody = (job: ActiveRecapJob): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        debug("recap-jobs", "running agent for", job.recapId);

        // Synchronous emitter wired into the job's subscriber set.
        // Same pattern as WalkthroughJobs: MCP tool handlers call this
        // synchronously so content events don't lag behind lifecycle events.
        // Time to the first nonempty streamed reasoning token. Synthetic phase
        // and activity events do not establish that the model has responded.
        // `agentStartMs` is set just before runRecapAgent, so the earlier
        // orchestrator "analyzing" phase emit doesn't count against it.
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
          fanOut(job, event);
        };

        // Repo metadata for the prompt.
        const repo = yield* provideDb(prCtx.getRepo(job.repoId)).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!repo) {
          const msg = "Repository not found — cannot build source bundle";
          logError("recap-jobs", `repo ${job.repoId} not found — marking recap error`);
          emit({ type: "error", data: { code: "RecapGenerationError", message: msg } });
          yield* setStatus(
            {
              id: job.recapId,
              repositoryId: job.repoId,
              period: job.period,
            },
            "error",
            { errorMessage: msg },
          );
          return;
        }

        // Source PRs + walkthroughs for the window. Read the local mirror
        // first — if backfill discovers nothing new, this is the only DB
        // query we make.
        let windowed = yield* provideDb(
          prService.listArchivedPrsForWindow(job.repoId, job.periodStart, job.periodEnd),
        ).pipe(Effect.catch(() => Effect.succeed([] as never[])));

        // Backfill any PRs that closed in this window but haven't yet
        // landed in the local mirror (poll cycle hadn't run, repo was
        // added mid-period, etc.). Hits GitHub's search API + getPr per
        // missing number. Failures degrade silently so the recap still
        // ships with whatever the mirror has.
        const backfill = yield* backfillMissingPrs(
          job.repoId,
          repo.fullName,
          job.periodStart,
          job.periodEnd,
          windowed,
        );
        if (backfill.addedCount > 0) {
          debug(
            "recap-jobs",
            `requerying window after backfill of ${backfill.addedCount} PR(s) for recap ${job.recapId}`,
          );
          windowed = yield* provideDb(
            prService.listArchivedPrsForWindow(job.repoId, job.periodStart, job.periodEnd),
          ).pipe(Effect.catch(() => Effect.succeed([] as never[])));
        }

        // PRs in flight for "who is working on what" context, reconstructed
        // as of the window's close so a historical recap doesn't describe
        // today's open PRs. Fetched before the empty-window guard so a window
        // with only open PRs can still produce an "active work" recap.
        const openPrs = yield* provideDb(
          prService.listOpenPrsAsOfWindow(job.repoId, job.periodEnd),
        ).pipe(Effect.catch(() => Effect.succeed([] as never[])));

        if (windowed.length === 0 && openPrs.length === 0) {
          // A window with nothing in it means two different things depending
          // on whether it's still open.
          if (windowIsCurrent(job.period, job.periodStart)) {
            // Live window: "nothing has happened yet, come back later" is the
            // right answer, and the page's Generate copy assumes it.
            const msg = "No archived or open PRs found for this window";
            logError(
              "recap-jobs",
              `no archived or open PRs for recap ${job.recapId} — marking error`,
            );
            emit({ type: "error", data: { code: "RecapGenerationError", message: msg } });
            yield* setStatus(
              {
                id: job.recapId,
                repositoryId: job.repoId,
                period: job.period,
              },
              "error",
              { errorMessage: msg },
            );
            return;
          }

          // Closed window: the answer is final and it's "nothing shipped".
          // That's a complete recap, not a failure — otherwise every quiet
          // weekend in the calendar would paint red. Short-circuit before the
          // agent runs so a quiet day costs zero tokens.
          debug(
            "recap-jobs",
            `empty historical window for recap ${job.recapId} — completing without the agent`,
          );
          yield* provideDb(recapService.markEmptyWindow(job.recapId)).pipe(
            Effect.catch(() => Effect.void),
          );
          yield* setStatus(
            {
              id: job.recapId,
              repositoryId: job.repoId,
              period: job.period,
            },
            "complete",
          );
          emit({ type: "done", data: { recapId: job.recapId } });
          return;
        }

        // Diff ingestion runs before the final recap agent. Raw patches are
        // compacted into durable per-PR digests so the final agent session can
        // scale with many PRs without retaining every raw diff in context.
        // `getPrDiff` remains as a fallback tool for parity/old prompts, but
        // the normal path reads `diffDigest` from get_recap_state.
        const repoClient = yield* Effect.cached(resolveRepoClient(job.repoId));
        const jobContext = yield* Effect.context<never>();
        const sourceRows = [...windowed, ...openPrs];
        const getPrDiff = (prId: string): Effect.Effect<RecapSourcePrDiff | null> => {
          const row = sourceRows.find((r) => r.pr.id === prId);
          if (!row) return Effect.succeed(null);
          return repoClient.pipe(
            Effect.flatMap((client) => loadDiffForPr(row.pr, repo.fullName, client)),
            Effect.provide(jobContext),
          );
        };

        // Compact diffs into per-PR digests for every PR (archived OR open)
        // that lacks a completed walkthrough. Open PRs follow the same
        // protocol as archived no-walkthrough PRs: the agent reads
        // `diffDigest` from the source bundle when writing each
        // `add_pr_entry` description. Without this open PRs would only carry
        // a body excerpt, and active-work entries would read very differently
        // from shipped entries.
        const digestEntries = yield* Effect.forEach(
          sourceRows.filter((row) => row.walkthrough === null),
          (row) =>
            Effect.gen(function* () {
              const diff = yield* loadDiffForPr(row.pr, repo.fullName, yield* repoClient).pipe(
                Effect.catch(() => Effect.succeed(null)),
              );
              const digest = buildDigestForRecapPr(row.pr, diff);
              yield* dbTry("persist recap digest", () =>
                db
                  .insert(recapPrDigests)
                  .values({
                    id: `${job.recapId}:${row.pr.id}`,
                    recapId: job.recapId,
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

        const digestByPrId = new Map<string, RecapSourcePrDigest>(digestEntries);
        const bundle = attachRecapDigests(
          buildSourceBundle(repo.fullName, job, windowed, openPrs),
          digestByPrId,
        );

        // Prior recaps for rolling context. Cheap query — at most a handful.
        const priorRecaps: ReadonlyArray<ProjectRecap> = yield* provideDb(
          recapService.getLatestForRepo(job.repoId, { limit: 5 }),
        ).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ProjectRecap>)));

        const launch = yield* resolveAgentLaunch("recap").pipe(
          Effect.provideService(SettingsService, settingsService),
        );
        if (!isAgentLaunchable(launch.agent)) {
          const msg = `The configured recap agent ('${launch.agent}') is not available on this machine.`;
          logError("recap-jobs", `recap ${job.recapId}: ${msg}`);
          emit({ type: "error", data: { code: "RecapGenerationError", message: msg } });
          yield* setStatus(
            { id: job.recapId, repositoryId: job.repoId, period: job.period },
            "error",
            { errorMessage: msg },
          );
          return;
        }

        const modelUsed = launch.model;
        let calledAnyTool = false;
        const ctx: RecapToolContext = {
          db,
          recapId: job.recapId,
          sourceBundle: bundle,
          priorRecaps,
          getPrDiff,
          emit,
          onToolCall: () => {
            calledAnyTool = true;
          },
          onCompleted: () => {
            job.validatedComplete = true;
            if (!job.abortController.signal.aborted) {
              job.abortController.abort(new Error("Recap completed"));
            }
          },
        };

        // Emit initial phase so the UI knows the job is active.
        emit({ type: "phase", data: { phase: "analyzing", message: "Analyzing pull requests…" } });

        agentStartMs = Date.now();
        const outcome = yield* Effect.acquireUseRelease(
          issueSessionToken(ctx),
          (sessionToken) =>
            Effect.promise(() =>
              runRecapAgentViaAcp({
                ctx,
                sessionToken,
                launch,
                workingDir: repo.clonePath ?? process.cwd(),
                abortController: job.abortController,
                calledAnyTool: () => calledAnyTool,
                isValidated: () => job.validatedComplete,
              }),
            ),
          (sessionToken) => clearSessionToken(sessionToken),
        );

        if (ttftMs !== null) yield* Effect.annotateCurrentSpan("ttft_ms", ttftMs);

        if (job.cancelledByUser) {
          emit({ type: "stopped", data: { recapId: job.recapId } });
          yield* setStatus(
            {
              id: job.recapId,
              repositoryId: job.repoId,
              period: job.period,
            },
            "stopped",
          );
          return;
        }

        const blocker = outcome.validated
          ? null
          : yield* dbTry("recap completion check", () => recapCompletionBlocker(db, job.recapId));
        if (blocker === null) {
          yield* setStatus(
            {
              id: job.recapId,
              repositoryId: job.repoId,
              period: job.period,
            },
            "complete",
            { modelUsed },
          );
          emit({ type: "done", data: { recapId: job.recapId } });
          return;
        }

        const msg =
          outcome.error ??
          "Agent finished without calling complete_recap — the overview may be empty or invalid";
        emit({ type: "error", data: { code: "RecapGenerationError", message: msg } });
        yield* setStatus(
          {
            id: job.recapId,
            repositoryId: job.repoId,
            period: job.period,
          },
          "error",
          { errorMessage: msg },
        );
      });

    const launchJob = (job: ActiveRecapJob) =>
      Effect.withSpan("ProjectRecapJobs.job")(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("recapId", job.recapId);
          yield* Effect.annotateCurrentSpan("period", job.period);
          yield* Ref.update(registry, (map) => {
            const next = new Map(map);
            next.set(job.recapId, job);
            return next;
          });

          const scopedBody = buildJobBody(job).pipe(
            // See WalkthroughJobs.launchJob — same reason, same ordering rule.
            withTraceAnchor(job.recapId),
            Effect.annotateLogs({ recapId: job.recapId, repoId: job.repoId }),
            semaphore.withPermits(1),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (
                  analyzeJobFailure(cause, { cancelledByUser: job.cancelledByUser }) ===
                  "leave-for-resume"
                ) {
                  // Process-shutdown interrupt with no user intent — leave the
                  // row 'generating' so resume-on-boot can pick it up.
                  return;
                }
                // A user-driven Stop, or a real failure. Either way the row
                // leaves 'generating' so the UI doesn't get stuck on it. (A
                // Stop may interrupt during DB read / bundle prep, before the
                // agent's AbortController could catch it.)
                const recap = { id: job.recapId, repositoryId: job.repoId, period: job.period };
                if (Cause.hasInterruptsOnly(cause)) {
                  fanOut(job, { type: "stopped", data: { recapId: job.recapId } });
                  yield* setStatus(recap, "stopped");
                  return;
                }
                logError("recap-jobs", `job ${job.recapId} failed:`, Cause.pretty(cause));
                const msg = `Generation failed unexpectedly: ${Cause.pretty(cause).slice(0, 200)}`;
                fanOut(job, {
                  type: "error",
                  data: { code: "RecapGenerationError", message: msg },
                });
                yield* setStatus(recap, "error", { errorMessage: msg });
              }),
            ),
            Effect.ensuring(removeJob(job)),
            // The generation span. Like WalkthroughJobs.generate, this wraps the
            // forked body so its duration is the real recap-generation time and
            // it can carry the ttft_ms annotation ('ProjectRecapJobs.job' forks
            // and returns in ~0ms).
            Effect.withSpan(SPAN.recapGenerate, {
              attributes: { recapId: job.recapId, period: job.period },
            }),
          );

          const fiber = yield* scopedBody.pipe(withGitHubOrigin("recap:job"), Effect.forkDetach);
          job.fiber = fiber as Fiber.Fiber<unknown, unknown>;
        }),
      );

    // ── Public API ──────────────────────────────────────────────────────

    const cancel = (recapId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(recapId);

        if (job) {
          job.cancelledByUser = true;
          try {
            if (!job.abortController.signal.aborted) {
              job.abortController.abort(new Error("Recap cancelled"));
            }
          } catch {
            /* already aborted */
          }
          // Don't wait for the fiber to finish interrupting — during
          // opencode "thinking" the remote session.abort() / prompt
          // shutdown can hang, and Fiber.interrupt would block the HTTP
          // stop request indefinitely. Fire-and-forget; the safety net
          // below transitions the row immediately.
          const fiber = job.fiber;
          if (fiber) {
            yield* Effect.sync(() => fiber.interruptUnsafe());
          }
          yield* clearTokensForRecap(recapId);
        }

        // Immediate safety net. Two cases land here:
        //
        //   (a) No live job in the registry — phantom row left in
        //       'generating' by a prior server crash / restart, before
        //       resumePending re-attached. cancel above was a no-op.
        //   (b) Live job whose abort signal didn't propagate cleanly
        //       through the agent SDK in time, so neither the body's
        //       cancelledByUser branch nor the launchJob catchAllCause
        //       managed to setStatus before Fiber.interrupt resolved.
        //
        // Either way, read the row's current status and force the
        // 'generating' → 'stopped' transition via the chokepoint here
        // (idempotent — UPDATE with the same status is harmless). This
        // is what guarantees the UI's SSE reducer flips the floating bar
        // out of the Stop state after the user clicks Stop.
        const row = yield* provideDb(recapService.getById(recapId)).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (row && row.status === "generating") {
          yield* setStatus(
            {
              id: row.id,
              repositoryId: row.repositoryId,
              period: row.period,
            },
            "stopped",
          );
        }
      });

    const startJob = (
      params: StartRecapJobParams,
    ): Effect.Effect<{ readonly recapId: string }, StartRecapJobError> =>
      Effect.gen(function* () {
        const { recapId } = params;
        const mutex = yield* startJobMutex.acquire(`recap:${recapId}`);
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            // Already running? Reuse, unless the old job was cancelled
            // or aborted and hasn't cleaned up from the registry yet.
            const existing = (yield* Ref.get(registry)).get(recapId);
            if (existing) {
              if (existing.cancelledByUser || existing.abortController.signal.aborted) {
                yield* removeJob(existing);
              } else {
                return { recapId };
              }
            }

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
              subscribers: new Set<SubscriberHandle<RecapStreamEvent>>(),
              nextSeq: 0,
            };
            yield* launchJob(job);
            return { recapId };
          }),
        );
      });

    const subscribe = (recapId: string, onEvent: Subscriber): Effect.Effect<SubscribeResult> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(recapId);
        if (!job) {
          return { found: false } as SubscribeResult;
        }
        const { unsubscribe, flush } = subscribers.subscribe(recapId, job, onEvent);
        return { found: true, unsubscribe, flush };
      });

    const emitEvent = (recapId: string, event: RecapStreamEvent): Effect.Effect<EmitResult> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(recapId);
        if (!job) {
          debug("recap-jobs", `emitEvent-no-job recap=${recapId} type=${event.type}`);
          return { kind: "skipped-no-job", recapId };
        }
        const seq = fanOut(job, event);
        return { kind: "delivered", seq };
      });

    /**
     * The window has no pull request that closed in it or was open as it
     * closed, as far as the local mirror knows. Same window boundary as
     * `buildJobBody`'s empty-window guard, so the two agree.
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
        const mutex = yield* startJobMutex.acquire(
          `window:${repoId}:${period}:${window.periodStart}`,
        );
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

            if (existing && plan === "reuse") return { recapId: existing.id };

            if (existing && plan === "rerun") {
              // Stop any fiber still writing into the row before resetting it.
              yield* cancel(existing.id);
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
              return yield* startJob({ recapId: existing.id, repoId, period, ...window });
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
            return yield* startJob({ recapId: created.id, repoId, period, ...window });
          }),
        );
      });

    const resumePending = (): Effect.Effect<void, DbError> =>
      Effect.withSpan("ProjectRecapJobs.resumePending")(
        Effect.gen(function* () {
          const rows = yield* provideDb(recapService.listGenerating());
          debug("recap-jobs", `resumePending: ${rows.length} row(s)`);
          for (const row of rows) {
            // An attempt that can't be counted isn't run: resuming it would
            // escape the resume budget (invariant #9).
            const attempts = yield* provideDb(recapService.incrementResumeAttempts(row.id)).pipe(
              Effect.catchTag("DbError", (err) =>
                Effect.sync(() => {
                  logError("recap-jobs", `resume of ${row.id} skipped:`, err.message);
                  return null;
                }),
              ),
            );
            if (attempts === null) continue;
            if (attempts > RECAP_MAX_RESUME_ATTEMPTS) {
              debug("recap-jobs", `recap ${row.id} exceeded resume attempts — marking error`);
              yield* setStatus(
                {
                  id: row.id,
                  repositoryId: row.repositoryId,
                  period: row.period,
                },
                "error",
                {
                  errorMessage: `Exceeded max resume attempts (${RECAP_MAX_RESUME_ATTEMPTS}) after repeated crashes`,
                },
              );
              continue;
            }
            yield* startJob({
              recapId: row.id,
              repoId: row.repositoryId,
              period: row.period,
              periodStart: row.periodStart,
              periodEnd: row.periodEnd,
            }).pipe(
              Effect.catchCause((cause) =>
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
        }),
      );

    return {
      startJob,
      requestRecap,
      cancel,
      resumePending,
      subscribe,
      emitEvent,
      resolveSessionToken,
    };
  }),
);
