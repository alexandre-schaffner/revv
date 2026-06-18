// ── ProjectRecapJobs ────────────────────────────────────────────────────────
// Durable orchestrator for daily / weekly project recap generation. Mirrors
// the structure of {@link WalkthroughJobs} but radically simpler:
//
//   • Single-phase MCP-routed pipeline (one atomic write per recap).
//   • No worktrees, no continuations, no SSE streaming. Status-only SSE
//     broadcasts; the recap UI re-fetches the row when needed.
//   • Per-(repoId, period, periodStart) mutex so concurrent claim paths
//     can't fork duplicate fibers.
//   • Bounded retries via `resume_attempts`. Boot resume re-runs the agent
//     from scratch — recap is single-phase so partial state is just the
//     row at `status='generating'` with empty content, which is
//     recoverable by re-running.
//
// Per CLAUDE.md invariants #2 and #11: agents never write `status`. This
// service is the sole writer. Content writes go through the recap MCP tool
// handlers in `ai/providers/recap-tools/`.

import type { ProjectRecap, RecapPeriod, RecapStreamEvent } from "@revv/shared";
import { sql } from "drizzle-orm";
import { Cause, Context, Effect, Fiber, Layer, Ref } from "effect";
import { isAcpAgentAvailable, resolveGenerationModel } from "../ai/acp/presets";
import type {
  RecapSourcePrDiff,
  RecapSourcePrDiffFile,
  RecapSourcePrDigest,
  RecapToolContext,
} from "../ai/providers/recap-tools";
import { recapPrDigests } from "../db/schema/index";
import { type RecapError, ValidationError } from "../domain/errors";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";
import { DiffCacheService } from "./DiffCache";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { analyzeJobFailure } from "./job-failure";
import { makeStartJobMutex } from "./job-mutex";
import { makeSubscriberRegistry, type SubscriberHandle } from "./job-subscribers";
import { PrContextService } from "./PrContext";
import { ProjectRecapService } from "./ProjectRecap";
import { type ArchivedPrWithWalkthrough, PullRequestService } from "./PullRequest";
import { runRecapAgent } from "./recap-agent-runner";
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

/** TTL for opencode HTTP-MCP session tokens (10-min cap + slack). */
const RECAP_SESSION_TOKEN_TTL_MS = 15 * 60_000;

// ── Types ────────────────────────────────────────────────────────────────────

type Subscriber = (event: RecapStreamEvent) => void;

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
  /** SSE subscribers keyed by opaque handle id. */
  readonly subscribers: Set<SubscriberHandle<RecapStreamEvent>>;
  /** Monotonic seq for tracing (in-memory diagnostic only). */
  nextSeq: number;
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
     * Issue an opaque session token bound to a prepared {@link RecapToolContext}.
     * The HTTP MCP route at `/mcp/recap` authenticates opencode tool calls
     * against this map and resolves them to the per-job context (recapId +
     * sourceBundle + priorRecaps + onCompleted hook). Mirrors the
     * walkthrough session-token pattern.
     */
    readonly issueSessionToken: (ctx: RecapToolContext) => Effect.Effect<string>;

    /**
     * Resolve a session token. Returns null when the token is unknown or
     * its TTL has elapsed.
     */
    readonly resolveSessionToken: (token: string) => Effect.Effect<RecapToolContext | null>;

    /** Invalidate a session token early (job end / cancel). */
    readonly clearSessionToken: (token: string) => Effect.Effect<void>;
  }
>() {}

// ── Live implementation ──────────────────────────────────────────────────────

export const ProjectRecapJobsLive = Layer.effect(
  ProjectRecapJobs,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const broadcaster = yield* Broadcaster;
    const recapService = yield* ProjectRecapService;
    const prService = yield* PullRequestService;
    const prCtx = yield* PrContextService;
    const settingsService = yield* SettingsService;
    const diffCache = yield* DiffCacheService;
    const etagCache = yield* GitHubEtagCache;

    const registry = yield* Ref.make(new Map<string, ActiveRecapJob>());
    const semaphore = yield* Effect.makeSemaphore(MAX_CONCURRENT_RECAP_JOBS);
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

    const broadcastRecapToRepoAccount = (
      repoId: string,
      msg: import("@revv/shared").ServerEventMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const accountId = yield* provideDb(prCtx.getAccountIdForRepo(repoId));
        yield* broadcaster.broadcastToAccount(accountId, msg);
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchAll(() => Effect.void),
      );

    /**
     * Provide the trio of services {@link PrContextService}'s GitHub-read
     * passthroughs need at execution time (etag cache, db handle, settings
     * for API base). Use this when calling things like `prCtx.prFiles` from
     * inside `Effect.gen` blocks that promise empty requirements.
     */
    const provideGithubDeps = <A, E>(
      eff: Effect.Effect<A, E, DbService | GitHubEtagCache | SettingsService>,
    ): Effect.Effect<A, E> =>
      eff.pipe(
        Effect.provideService(DbService, { db }),
        Effect.provideService(GitHubEtagCache, etagCache),
        Effect.provideService(SettingsService, settingsService),
      );

    // ── Status chokepoint (CLAUDE.md invariant #11) ─────────────────────
    const setStatus = (
      recap: { id: string; repositoryId: string; period: RecapPeriod },
      status: "generating" | "complete" | "error" | "superseded",
      options?: { tokenUsage?: Record<string, number>; modelUsed?: string; errorMessage?: string },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* provideDb(recapService.setStatus(recap.id, status, options));
        // Reload completedAt so the broadcast payload is accurate.
        const fresh = yield* provideDb(recapService.getById(recap.id)).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
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
        yield* broadcastRecapToRepoAccount(recap.repositoryId, {
          type: "recap:status-changed",
          data,
        });
        // For 'complete', also broadcast the fresh row so the UI can render
        // immediately without re-fetching.
        if (status === "complete" && fresh) {
          yield* broadcastRecapToRepoAccount(recap.repositoryId, {
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

    /**
     * Resolve the GitHub token for a repo via its `accountId`. We can't go
     * through `PrContextService.resolveBasic` because it requires a
     * `userId`; recap jobs are background and aren't tied to a session.
     * `getTokenByAccountId` is the same auth fallback `PrContextService`
     * itself prefers, so the resulting token is whatever the OAuth flow
     * minted for the owning account.
     */
    const resolveRepoToken = (repoId: string): Effect.Effect<string | null> =>
      prCtx.resolveRepoToken(repoId).pipe(
        Effect.provideService(DbService, { db }),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            debug(
              "recap-jobs",
              `token lookup failed for repo ${repoId} — recap will fall back to cache-only diffs:`,
              err instanceof Error ? err.message : String(err),
            );
            return null;
          }),
        ),
      );

    /**
     * Materialize a {@link RecapSourcePrDiff} for a single PR. Tries the
     * cache first, then GitHub on a cache miss. Any failure degrades to
     * `null` (PR keeps metadata-only) rather than failing the recap.
     */
    const loadDiffForPr = (
      pr: ArchivedPrWithWalkthrough["pr"],
      repoFullName: string,
      token: string | null,
    ): Effect.Effect<RecapSourcePrDiff | null> =>
      Effect.gen(function* () {
        const cached = yield* provideDb(diffCache.getCachedFiles(pr.id));

        const buildFromFiles = (
          files: ReadonlyArray<{
            readonly path: string;
            readonly oldPath: string | null;
            readonly status: string;
            readonly additions: number;
            readonly deletions: number;
            readonly patch: string | null;
          }>,
          source: "cache" | "github",
        ): RecapSourcePrDiff => {
          const totalFiles = files.length;
          const trimmed = files.slice(0, RECAP_DIFF_MAX_FILES_PER_PR);
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
            source,
            note: notes.length > 0 ? notes.join(" ") : null,
          };
        };

        if (cached !== null) {
          return buildFromFiles(cached, "cache");
        }

        if (token === null) {
          return {
            files: [],
            totalFiles: 0,
            filesTruncated: false,
            source: "unavailable",
            note: "No diff cached locally and no GitHub token available — describe this PR from title/body/+/- counts only.",
          } satisfies RecapSourcePrDiff;
        }

        const fetched = yield* provideGithubDeps(
          prCtx.prFiles(repoFullName, pr.externalId, token),
        ).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              debug(
                "recap-jobs",
                `getPrFiles failed for pr ${pr.id} (#${pr.externalId}) — recap will skip diff:`,
                err instanceof Error ? err.message : String(err),
              );
              return null;
            }),
          ),
        );
        if (fetched === null) {
          return {
            files: [],
            totalFiles: 0,
            filesTruncated: false,
            source: "unavailable",
            note: "Diff fetch from GitHub failed — describe this PR from title/body/+/- counts only.",
          } satisfies RecapSourcePrDiff;
        }

        // Best-effort cache write so a retry doesn't re-pay the GitHub
        // round-trip. Failure is non-fatal — we still return the diff.
        yield* provideDb(
          diffCache.cacheFiles(
            pr.id,
            fetched.map((f) => ({
              path: f.filename,
              oldPath: f.previousFilename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              patch: f.patch,
              fetchedAt: new Date().toISOString(),
            })),
          ),
        ).pipe(Effect.catchAll(() => Effect.void));

        return buildFromFiles(
          fetched.map((f) => ({
            path: f.filename,
            oldPath: f.previousFilename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
          })),
          "github",
        );
      });

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
        const token = yield* resolveRepoToken(repoId);
        if (token === null) {
          debug("recap-jobs", `backfill skipped for repo ${repoId} — no GitHub token resolvable`);
          return { addedCount: 0 };
        }

        const searched = yield* provideGithubDeps(
          prCtx.searchClosedPrs(repoFullName, periodStart, periodEnd, token),
        ).pipe(
          Effect.catchAll((err) =>
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

        // Fetch full PR data for each missing number. Bounded concurrency
        // mirrors the diff loader. Failures degrade silently — a missing
        // backfill row just means that one PR stays absent from the recap.
        const fetched = yield* Effect.forEach(
          missing,
          (m) =>
            provideGithubDeps(prCtx.fetchPr(repoFullName, m.number, token)).pipe(
              Effect.catchAll((err) =>
                Effect.sync(() => {
                  debug(
                    "recap-jobs",
                    `getPr #${m.number} failed during backfill for ${repoFullName}:`,
                    err instanceof Error ? err.message : String(err),
                  );
                  return null;
                }),
              ),
            ),
          { concurrency: 3 },
        );

        // Repoint every fetched row at our local repo id — `getPr` derives
        // `id` and `repositoryId` from `${owner}/${repo}` because it
        // doesn't know the local row id (see `mapPr` in GitHub.ts).
        const upsertable = fetched
          .filter((pr): pr is NonNullable<typeof pr> => pr !== null)
          .map((pr) => ({
            ...pr,
            id: `${repoId}:${pr.externalId}`,
            repositoryId: repoId,
          }));

        if (upsertable.length === 0) return { addedCount: 0 };

        yield* provideDb(prService.upsertPrs(upsertable)).pipe(
          Effect.catchAll((err) =>
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

    const buildJobBody = (job: ActiveRecapJob): Effect.Effect<void> =>
      Effect.gen(function* () {
        debug("recap-jobs", "running agent for", job.recapId);

        // Synchronous emitter wired into the job's subscriber set.
        // Same pattern as WalkthroughJobs: MCP tool handlers call this
        // synchronously so content events don't lag behind lifecycle events.
        const emit = (event: RecapStreamEvent): void => {
          fanOut(job, event);
        };

        // Repo metadata for the prompt.
        const repo = yield* provideDb(prCtx.getRepo(job.repoId)).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
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
        ).pipe(Effect.catchAll(() => Effect.succeed([] as never[])));

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
          ).pipe(Effect.catchAll(() => Effect.succeed([] as never[])));
        }

        // Open PRs for "who is working on what" context. Fetched before
        // the empty-archive guard so a window with only open PRs can still
        // produce an "active work" recap instead of an error.
        const openPrs = yield* provideDb(prService.listOpenPrsWithWalkthroughs(job.repoId)).pipe(
          Effect.catchAll(() => Effect.succeed([] as never[])),
        );

        if (windowed.length === 0 && openPrs.length === 0) {
          // Scheduler should have filtered fully-empty repos out, but defend:
          // mark the row error with a clear reason rather than spinning.
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

        // Diff ingestion runs before the final recap agent. Raw patches are
        // compacted into durable per-PR digests so the final agent session can
        // scale with many PRs without retaining every raw diff in context.
        // `getPrDiff` remains as a fallback tool for parity/old prompts, but
        // the normal path reads `diffDigest` from get_recap_state.
        let cachedToken: string | null | undefined;
        const getPrDiff = async (prId: string): Promise<RecapSourcePrDiff | null> => {
          if (cachedToken === undefined) {
            cachedToken = await Effect.runPromise(resolveRepoToken(job.repoId));
          }
          const allRows = [...windowed, ...openPrs];
          const row = allRows.find((r) => r.pr.id === prId);
          if (!row) return null;
          return Effect.runPromise(loadDiffForPr(row.pr, repo.fullName, cachedToken));
        };

        // Compact diffs into per-PR digests for every PR (archived OR open)
        // that lacks a completed walkthrough. Open PRs follow the same
        // protocol as archived no-walkthrough PRs: the agent reads
        // `diffDigest` from the source bundle when writing each
        // `add_pr_entry` description. Without this open PRs would only carry
        // a body excerpt, and active-work entries would read very differently
        // from shipped entries.
        const digestEntries = yield* Effect.forEach(
          [...windowed, ...openPrs].filter((row) => row.walkthrough === null),
          (row) =>
            Effect.gen(function* () {
              if (cachedToken === undefined) {
                cachedToken = yield* resolveRepoToken(job.repoId);
              }
              const diff = yield* loadDiffForPr(row.pr, repo.fullName, cachedToken).pipe(
                Effect.catchAll(() => Effect.succeed(null)),
              );
              const digest = buildDigestForRecapPr(row.pr, diff);
              yield* Effect.try({
                try: () => {
                  db.insert(recapPrDigests)
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
                    .run();
                },
                catch: (e) => new ValidationError({ message: String(e) }),
              }).pipe(
                Effect.catchAll((err) =>
                  Effect.sync(() => {
                    logError(
                      "recap-jobs",
                      `failed to persist recap digest for ${row.pr.id}:`,
                      err instanceof Error ? err.message : String(err),
                    );
                  }),
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
        ).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<ProjectRecap>)));

        const settings = yield* provideDb(settingsService.getSettings()).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );

        // Resolve the effective agent. Per-feature `recap.agent` setting
        // (CLAUDE.md note: this lets users run Claude for interactive work
        // and opencode for background recaps, or vice versa). Defaults to
        // `'auto'` which inherits the global `aiAgent`.
        const effectiveAgent = yield* provideDb(settingsService.resolveRecapAgent()).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => {
              logError(
                "recap-jobs",
                `resolveRecapAgent failed; falling back to 'claude-code':`,
                e instanceof Error ? e.message : String(e),
              );
              return "claude-code" as const;
            }),
          ),
        );

        // Recap generation runs exclusively on the ACP transport now. The shared
        // MCP tool handlers behind `/mcp/recap` are the same code every agent
        // reaches (CLAUDE.md invariant #13 — agent-path parity).
        const acpAgentId = effectiveAgent;
        if (!isAcpAgentAvailable(acpAgentId)) {
          const msg = `The configured recap agent ('${acpAgentId}') is not available on this machine.`;
          logError("recap-jobs", `recap ${job.recapId}: ${msg}`);
          emit({ type: "error", data: { code: "RecapGenerationError", message: msg } });
          yield* setStatus(
            { id: job.recapId, repositoryId: job.repoId, period: job.period },
            "error",
            { errorMessage: msg },
          );
          return;
        }

        // Session-token deps for the `/mcp/recap` HTTP bearer. Threaded through
        // as callbacks so `recap-agent-runner.ts` stays decoupled from the
        // Effect runtime (and avoids a layer cycle with this service).
        const sessionDeps = {
          issueSessionToken: (ctx: RecapToolContext) => Effect.runPromise(issueSessionToken(ctx)),
          clearSessionToken: (token: string) => Effect.runPromise(clearSessionToken(token)),
        };

        // Emit initial phase so the UI knows the job is active.
        emit({ type: "phase", data: { phase: "analyzing", message: "Analyzing pull requests…" } });

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
              modelUsed:
                resolveGenerationModel(effectiveAgent, settings?.aiModel) ?? "claude-opus-4-5",
              acpAgentId,
              thinkingEffort: settings?.aiThinkingEffort,
              contextWindow: settings?.aiContextWindow,
              repoWorkingDir: repo.clonePath ?? process.cwd(),
              sessionDeps,
              onCompleted: () => {
                job.validatedComplete = true;
              },
              getPrDiff,
              emitEvent: emit,
            });
          },
          catch: (e) => new ValidationError({ message: String(e) }),
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              logError("recap-jobs", `runRecapAgent failed for ${job.recapId}:`, err);
              return null;
            }),
          ),
        );

        if (job.cancelledByUser) {
          const msg = "Cancelled by user";
          debug("recap-jobs", "job cancelled by user — leaving row for cleanup");
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
          emit({ type: "done", data: { recapId: job.recapId } });
          return;
        }

        // Agent terminated without validation. Mark error.
        const msg =
          result?.errorMessage ??
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
            Effect.annotateLogs({ recapId: job.recapId, repoId: job.repoId }),
            semaphore.withPermits(1),
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                if (
                  analyzeJobFailure(cause, { cancelledByUser: job.cancelledByUser }) ===
                  "leave-for-resume"
                ) {
                  // Process-shutdown interrupt with no user intent — leave the
                  // row 'generating' so resume-on-boot can pick it up.
                  return;
                }
                // A real failure, or a user-driven Stop. Transition the row to
                // 'error' so the UI doesn't get stuck on 'generating'. (A Stop
                // may interrupt during DB read / bundle prep, before the
                // agent's AbortController could catch — this catch-all still
                // flips the row.)
                const interruptedOnly = Cause.isInterruptedOnly(cause);
                const msg = interruptedOnly
                  ? "Cancelled by user"
                  : `Generation failed unexpectedly: ${Cause.pretty(cause).slice(0, 200)}`;
                if (!interruptedOnly) {
                  logError("recap-jobs", `job ${job.recapId} failed:`, Cause.pretty(cause));
                }
                fanOut(job, {
                  type: "error",
                  data: { code: "RecapGenerationError", message: msg },
                });
                yield* setStatus(
                  {
                    id: job.recapId,
                    repositoryId: job.repoId,
                    period: job.period,
                  },
                  "error",
                  { errorMessage: msg },
                );
              }),
            ),
            Effect.ensuring(removeJob(job)),
          );

          const fiber = yield* Effect.forkDaemon(scopedBody);
          job.fiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
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
          if (job.fiber) {
            yield* Fiber.interruptFork(job.fiber);
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
        // 'generating' → 'error' transition via the chokepoint here
        // (idempotent — UPDATE with the same status is harmless). This
        // is what guarantees the UI's SSE reducer flips the floating bar
        // out of the Stop state after the user clicks Stop.
        const row = yield* provideDb(recapService.getById(recapId)).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        if (row && row.status === "generating") {
          yield* setStatus(
            {
              id: row.id,
              repositoryId: row.repositoryId,
              period: row.period,
            },
            "error",
            { errorMessage: "Cancelled by user" },
          );
        }
      });

    const startJob = (
      params: StartRecapJobParams,
    ): Effect.Effect<{ readonly recapId: string }, StartRecapJobError> =>
      Effect.gen(function* () {
        const mutexKey = `${params.repoId}:${params.period}:${params.periodStart}`;
        const mutex = yield* startJobMutex.acquire(mutexKey);
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
              yield* broadcastRecapToRepoAccount(params.repoId, {
                type: "recap:added",
                data: { recap: created },
              });
            }

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

    const regenerateForPeriod = (params: {
      readonly repoId: string;
      readonly period: RecapPeriod;
      readonly periodStart: string;
      readonly periodEnd: string;
    }): Effect.Effect<{ readonly recapId: string }, StartRecapJobError> =>
      Effect.gen(function* () {
        // "Max 1 active recap per (repo, period, periodStart)" rule:
        // if a row already exists for this window, reset it in place
        // instead of creating a new one + superseding the old.
        const existing = yield* provideDb(
          recapService.findActiveForPeriod(params.repoId, params.period, params.periodStart),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (existing) {
          // Cancel any in-flight fiber for this recap before resetting
          // the row — otherwise the running fiber would race the reset
          // and clobber the cleared fields.
          yield* cancel(existing.id);

          yield* provideDb(
            recapService.resetForRerun(existing.id, {
              periodStart: params.periodStart,
              periodEnd: params.periodEnd,
            }),
          );

          // Re-broadcast the row so the UI swaps it back to the
          // "generating" state. The reducer matches on id and replaces
          // the existing entry in place — `completedAt`/`errorMessage`
          // get cleared, `generatedAt` advances. We re-read the row so
          // the payload reflects the post-reset state.
          const refreshed = yield* provideDb(recapService.getById(existing.id)).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (refreshed) {
            yield* broadcastRecapToRepoAccount(params.repoId, {
              type: "recap:added",
              data: { recap: refreshed },
            });
          }

          return yield* startJob({
            recapId: existing.id,
            repoId: params.repoId,
            period: params.period,
            periodStart: params.periodStart,
            periodEnd: params.periodEnd,
            trigger: "manual",
          });
        }

        // No existing row — create a fresh one and start.
        const newRow = yield* provideDb(
          recapService.createPartial({
            repositoryId: params.repoId,
            period: params.period,
            periodStart: params.periodStart,
            periodEnd: params.periodEnd,
          }),
        );
        yield* broadcastRecapToRepoAccount(params.repoId, {
          type: "recap:added",
          data: { recap: newRow },
        });

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
      Effect.withSpan("ProjectRecapJobs.resumePending")(
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
        }),
      );

    return {
      startJob,
      regenerateForPeriod,
      cancel,
      resumePending,
      subscribe,
      emitEvent,
      issueSessionToken,
      resolveSessionToken,
      clearSessionToken,
    };
  }),
);
