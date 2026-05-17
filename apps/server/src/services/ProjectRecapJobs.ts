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

import type { ProjectRecap, RecapPeriod, RecapStreamEvent, RecapSummaryStats } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Cause, Context, Effect, Fiber, Layer, Ref } from "effect";
import type {
  RecapSourceBundle,
  RecapSourcePr,
  RecapSourcePrDiff,
  RecapSourcePrDiffFile,
  RecapToolContext,
} from "../ai/providers/recap-tools";
import { repositories } from "../db/schema/index";
import { type RecapError, ValidationError } from "../domain/errors";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { resolveRecapAgent } from "./Ai";
import { DbService } from "./Db";
import { DiffCacheService } from "./DiffCache";
import { GitHubService } from "./GitHub";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { OpencodeSupervisor } from "./OpencodeSupervisor";
import { ProjectRecapService } from "./ProjectRecap";
import { type ArchivedPrWithWalkthrough, PullRequestService } from "./PullRequest";
import { RepositoryService } from "./Repository";
import { runRecapAgent } from "./recap-agent-runner";
import { SettingsService } from "./Settings";
import { TokenProvider } from "./TokenProvider";
import { WebSocketHub } from "./WebSocketHub";

// ── Constants ────────────────────────────────────────────────────────────────

/** Cap on concurrent recap jobs. Lower than walkthroughs — recap calls are heavier per turn. */
export const MAX_CONCURRENT_RECAP_JOBS = 2;

/** Resume-on-boot retry budget. After this many attempts the row goes to 'error'. */
export const RECAP_MAX_RESUME_ATTEMPTS = 3;

/**
 * TTL for opencode HTTP-MCP session tokens. Covers the runner's 10-minute
 * soft cap plus slack for slow daemon startups and retries. Tokens are
 * cleared automatically on job end via `Effect.ensuring`; this TTL is a
 * defensive ceiling so a leaked token can't outlive the job indefinitely.
 */
const RECAP_SESSION_TOKEN_TTL_MS = 15 * 60_000;

/**
 * Per-PR caps applied when we surface a diff to the recap agent as a
 * walkthrough fallback. These are intentionally aggressive — the agent only
 * needs a high-level read on the change, not every line, and the bundle is
 * already carrying metadata + body for every PR in the window.
 */
const RECAP_DIFF_MAX_FILES_PER_PR = 25;
const RECAP_DIFF_MAX_PATCH_CHARS = 3000;

// ── Types ────────────────────────────────────────────────────────────────────

type Subscriber = (event: RecapStreamEvent) => void;

interface SubscriberHandle {
  readonly id: string;
  readonly callback: Subscriber;
  /** Buffer for pre-flush events. Null after flush (direct-forward mode). */
  buffered: RecapStreamEvent[] | null;
  /** Consecutive failure counter. Dropped after 3 consecutive throws. */
  consecutiveFailures: number;
}

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
  readonly subscribers: Set<SubscriberHandle>;
  /** Monotonic seq for tracing. */
  nextSeq: number;
  /**
   * In-memory previous overview to thread into the source bundle. Set by
   * `regenerateForPeriod` when reusing an existing row; null on a fresh
   * row.
   */
  readonly previousOverview: string | null;
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
  /**
   * Markdown overview from the prior recap row for this same window.
   * Threaded into the source bundle so the agent treats this run as an
   * in-place update rather than a fresh write. Only set by
   * `regenerateForPeriod` on the rerun path. Lives in memory only —
   * a crash + resume loses this context; the agent rebuilds from the
   * current bundle (which is acceptable degradation for a rare path).
   */
  readonly previousOverview?: string;
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
    const hub = yield* WebSocketHub;
    const recapService = yield* ProjectRecapService;
    const prService = yield* PullRequestService;
    const repoService = yield* RepositoryService;
    const settingsService = yield* SettingsService;
    const supervisor = yield* OpencodeSupervisor;
    const diffCache = yield* DiffCacheService;
    const github = yield* GitHubService;
    const tokenProvider = yield* TokenProvider;
    const etagCache = yield* GitHubEtagCache;

    const registry = yield* Ref.make(new Map<string, ActiveRecapJob>());
    const semaphore = yield* Effect.makeSemaphore(MAX_CONCURRENT_RECAP_JOBS);
    const startJobMutexes = yield* Ref.make(new Map<string, Effect.Semaphore>());

    // ── Session-token registry (opencode HTTP-MCP) ────────────────────────
    // Holds prepared RecapToolContexts keyed by an opaque bearer token. The
    // `/mcp/recap` route resolves the token → context per JSON-RPC call.
    // Per CLAUDE.md invariant #1, this is ephemeral coordination: a server
    // restart wipes the map; the orchestrator's resume path rebuilds it on
    // the next run.
    interface SessionEntry {
      readonly ctx: RecapToolContext;
      readonly expiresAt: number;
    }
    const sessionTokens = yield* Ref.make(new Map<string, SessionEntry>());

    const issueSessionToken = (ctx: RecapToolContext): Effect.Effect<string> =>
      Effect.gen(function* () {
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + RECAP_SESSION_TOKEN_TTL_MS;
        yield* Ref.update(sessionTokens, (map) => {
          const next = new Map(map);
          next.set(token, { ctx, expiresAt });
          return next;
        });
        return token;
      });

    const resolveSessionToken = (token: string): Effect.Effect<RecapToolContext | null> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionTokens);
        const entry = map.get(token);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
          yield* Ref.update(sessionTokens, (m) => {
            if (!m.has(token)) return m;
            const next = new Map(m);
            next.delete(token);
            return next;
          });
          return null;
        }
        return entry.ctx;
      });

    const clearSessionToken = (token: string): Effect.Effect<void> =>
      Ref.update(sessionTokens, (map) => {
        if (!map.has(token)) return map;
        const next = new Map(map);
        next.delete(token);
        return next;
      });

    const provideDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
      withDb(db, eff);

    /**
     * Provide the trio of services {@link GitHubService}'s read methods need
     * at execution time (etag cache, db handle, settings for API base).
     * Use this when calling things like `github.getPrFiles` from inside
     * `Effect.gen` blocks that promise empty requirements.
     */
    const provideGithubDeps = <A, E>(
      eff: Effect.Effect<A, E, DbService | GitHubEtagCache | SettingsService>,
    ): Effect.Effect<A, E> =>
      eff.pipe(
        Effect.provideService(DbService, { db }),
        Effect.provideService(GitHubEtagCache, etagCache),
        Effect.provideService(SettingsService, settingsService),
      );

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
      options?: { tokenUsage?: Record<string, number>; modelUsed?: string; errorMessage?: string },
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

    // ── Subscriber fan-out ──────────────────────────────────────────────

    let nextHandleId = 1;

    const fanOut = (job: ActiveRecapJob, event: RecapStreamEvent): number => {
      const seq = job.nextSeq++;
      const subsCount = job.subscribers.size;
      debug(
        "recap-jobs",
        `fanOut recap=${job.recapId} seq=${seq} type=${event.type} subs=${subsCount}`,
      );
      if (subsCount === 0) {
        debug(
          "recap-jobs",
          `fanOut-no-subscribers recap=${job.recapId} seq=${seq} type=${event.type}`,
        );
      }
      const toDrop: SubscriberHandle[] = [];
      for (const handle of job.subscribers) {
        try {
          if (handle.buffered !== null) {
            handle.buffered.push(event);
            debug(
              "recap-jobs",
              `fanOut-buffered recap=${job.recapId} seq=${seq} type=${event.type} handle=${handle.id} bufLen=${handle.buffered.length}`,
            );
          } else {
            handle.callback(event);
            debug(
              "recap-jobs",
              `fanOut-delivered recap=${job.recapId} seq=${seq} type=${event.type} handle=${handle.id}`,
            );
          }
          handle.consecutiveFailures = 0;
        } catch (err) {
          handle.consecutiveFailures += 1;
          if (handle.consecutiveFailures >= 3) {
            toDrop.push(handle);
            logError(
              "recap-jobs",
              `subscriber dropped after 3 consecutive failures recap=${job.recapId} seq=${seq} handle=${handle.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          } else {
            logError(
              "recap-jobs",
              `subscriber threw (${handle.consecutiveFailures}/3) recap=${job.recapId} seq=${seq} type=${event.type} handle=${handle.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
      for (const handle of toDrop) {
        job.subscribers.delete(handle);
      }
      return seq;
    };

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
      Effect.gen(function* () {
        const row = yield* Effect.sync(() =>
          db
            .select({ accountId: repositories.accountId })
            .from(repositories)
            .where(eq(repositories.id, repoId))
            .get(),
        );
        if (!row) return null;
        return yield* tokenProvider.getTokenByAccountId(row.accountId).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              debug(
                "recap-jobs",
                `token lookup failed for account ${row.accountId} — recap will fall back to cache-only diffs:`,
                err instanceof Error ? err.message : String(err),
              );
              return null;
            }),
          ),
        );
      });

    /**
     * Clip a single file's patch text to fit the per-file char budget.
     * Returns the bounded patch plus a flag indicating truncation, so the
     * agent can know it isn't seeing the whole file change.
     */
    const truncatePatch = (patch: string | null): { patch: string | null; truncated: boolean } => {
      if (patch === null) return { patch: null, truncated: false };
      if (patch.length <= RECAP_DIFF_MAX_PATCH_CHARS) {
        return { patch, truncated: false };
      }
      return {
        patch: `${patch.slice(0, RECAP_DIFF_MAX_PATCH_CHARS)}\n[…patch truncated to ${RECAP_DIFF_MAX_PATCH_CHARS} chars — original ${patch.length}…]`,
        truncated: true,
      };
    };

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
          github.getPrFiles(repoFullName, pr.externalId, token),
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

    /**
     * Resolve diffs for the subset of PRs missing a walkthrough. Returns a
     * map keyed by `pr.id`. Walkthroughed PRs are skipped because their
     * narrative already contains everything the recap needs.
     */
    const loadDiffsForRecap = (
      repoId: string,
      repoFullName: string,
      windowed: ReadonlyArray<ArchivedPrWithWalkthrough>,
    ): Effect.Effect<Map<string, RecapSourcePrDiff>> =>
      Effect.gen(function* () {
        const missing = windowed.filter((row) => row.walkthrough === null);
        if (missing.length === 0) return new Map<string, RecapSourcePrDiff>();

        const token = yield* resolveRepoToken(repoId);

        // Bounded concurrency: 3 in flight at once balances GitHub
        // rate-limit friendliness against recap latency for a typical
        // weekly window (≤ ~15 PRs).
        const entries = yield* Effect.forEach(
          missing,
          (row) =>
            loadDiffForPr(row.pr, repoFullName, token).pipe(
              Effect.map((diff) => [row.pr.id, diff] as const),
            ),
          { concurrency: 3 },
        );

        const map = new Map<string, RecapSourcePrDiff>();
        for (const [prId, diff] of entries) {
          if (diff !== null) map.set(prId, diff);
        }
        return map;
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
          github.searchClosedPrsInWindow(repoFullName, periodStart, periodEnd, token),
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
            provideGithubDeps(github.getPr(repoFullName, m.number, token)).pipe(
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

    // ── Source bundle assembly ──────────────────────────────────────────

    const buildSourceBundle = (
      repoFullName: string,
      params: {
        repoId: string;
        period: RecapPeriod;
        periodStart: string;
        periodEnd: string;
        previousOverview: string | null;
      },
      windowed: ReadonlyArray<ArchivedPrWithWalkthrough>,
      openPrs: ReadonlyArray<ArchivedPrWithWalkthrough>,
      diffsByPrId: ReadonlyMap<string, RecapSourcePrDiff>,
    ): RecapSourceBundle => {
      const toRecapPr = (
        row: ArchivedPrWithWalkthrough,
        statusOverride?: "open",
      ): RecapSourcePr => {
        const pr = row.pr;
        return {
          id: pr.id,
          externalId: pr.externalId,
          title: pr.title,
          authorLogin: pr.authorLogin,
          status:
            statusOverride ??
            ((pr.status === "merged" ? "merged" : "closed") as "merged" | "closed"),
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
          // Only carry a diff for archived PRs that have no walkthrough —
          // when a walkthrough exists, its narrative is the canonical
          // summary. Open PRs are surfaced for "active work" context only
          // and don't need diffs in the recap.
          diff: row.walkthrough === null ? (diffsByPrId.get(pr.id) ?? null) : null,
        };
      };

      const prs: RecapSourcePr[] = windowed.map((row) => toRecapPr(row));
      const openPrList: RecapSourcePr[] = openPrs.map((row) => toRecapPr(row, "open"));

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
        openPrs: openPrList,
        stats,
        previousOverview: params.previousOverview,
      };
    };

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
        const repo = yield* provideDb(repoService.getRepoById(job.repoId)).pipe(
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

        // For PRs without a walkthrough, pull the diff so the agent can
        // describe the change directly instead of guessing from title /
        // +/- counts. Cache-then-GitHub with hard per-PR caps; failures
        // degrade silently to metadata-only for the affected PR.
        const diffsByPrId = yield* loadDiffsForRecap(job.repoId, repo.fullName, windowed).pipe(
          Effect.catchAll(() => Effect.sync(() => new Map<string, RecapSourcePrDiff>())),
        );

        const bundle = buildSourceBundle(repo.fullName, job, windowed, openPrs, diffsByPrId);

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
        const effectiveAgent = settings
          ? (() => {
              try {
                return resolveRecapAgent(settings);
              } catch (e) {
                logError(
                  "recap-jobs",
                  `resolveRecapAgent failed; falling back to 'claude':`,
                  e instanceof Error ? e.message : String(e),
                );
                return "claude" as const;
              }
            })()
          : ("claude" as const);

        // Supervisor + session-token deps. Threaded through as callbacks so
        // `recap-agent-runner.ts` stays decoupled from the Effect runtime
        // (and avoids a layer cycle with this service).
        const supervisorDeps = {
          ensureDaemon: () => Effect.runPromise(supervisor.ensureRunning()),
          jobStarted: () => Effect.runPromise(supervisor.jobStarted()),
          jobEnded: () => Effect.runPromise(supervisor.jobEnded()),
          client: () => Effect.runPromise(supervisor.client()),
        };
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
              modelUsed: settings?.aiModel ?? "claude-opus-4-5",
              effectiveAgent,
              aiMaxTurns: settings?.aiMaxTurns ?? 12,
              repoWorkingDir: repo.clonePath ?? process.cwd(),
              supervisorDeps,
              sessionDeps,
              onCompleted: () => {
                job.validatedComplete = true;
              },
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
              if (interruptedOnly) return;
              const msg = `Generation failed unexpectedly: ${Cause.pretty(cause).slice(0, 200)}`;
              logError("recap-jobs", `job ${job.recapId} failed:`, Cause.pretty(cause));
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
              subscribers: new Set<SubscriberHandle>(),
              nextSeq: 0,
              previousOverview: params.previousOverview ?? null,
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
        const handleId = String(nextHandleId++);
        const handle: SubscriberHandle = {
          id: handleId,
          callback: onEvent,
          buffered: [],
          consecutiveFailures: 0,
        };
        job.subscribers.add(handle);
        debug(
          "recap-jobs",
          `subscribe recap=${recapId} handle=${handleId} subs=${job.subscribers.size} nextSeq=${job.nextSeq}`,
        );
        return {
          found: true,
          unsubscribe: () => {
            const removed = job.subscribers.delete(handle);
            debug(
              "recap-jobs",
              `unsubscribe recap=${recapId} handle=${handleId} removed=${removed} subs=${job.subscribers.size}`,
            );
          },
          flush: () => {
            const buf = handle.buffered;
            handle.buffered = null;
            const flushed = buf?.length ?? 0;
            debug(
              "recap-jobs",
              `flush recap=${recapId} handle=${handleId} flushedEvents=${flushed}`,
            );
            if (buf) {
              for (const event of buf) {
                try {
                  onEvent(event);
                } catch (err) {
                  logError(
                    "recap-jobs",
                    `subscriber flush threw recap=${recapId} handle=${handleId} type=${event.type}:`,
                    err instanceof Error ? err.message : String(err),
                  );
                }
              }
            }
          },
        };
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
        // if a row already exists for this window, update it in place
        // instead of creating a new one + superseding the old. The agent
        // receives the prior overview as context and writes the next
        // version on top of it.
        const existing = yield* provideDb(
          recapService.findActiveForPeriod(params.repoId, params.period, params.periodStart),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (existing) {
          // Cancel any in-flight fiber for this recap before resetting
          // the row — otherwise the running fiber would race the reset
          // and clobber the cleared fields.
          yield* cancel(existing.id);

          const { previousOverview } = yield* provideDb(recapService.resetForRerun(existing.id));

          // Re-broadcast the row so the UI swaps it back to the
          // "generating" state. The reducer matches on id and replaces
          // the existing entry in place — `completedAt`/`errorMessage`
          // get cleared, `generatedAt` advances. We re-read the row so
          // the payload reflects the post-reset state.
          const refreshed = yield* provideDb(recapService.getById(existing.id)).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (refreshed) {
            yield* hub.broadcast({ type: "recap:added", data: { recap: refreshed } }).pipe(
              Effect.timeout("5 seconds"),
              Effect.catchAll(() => Effect.void),
            );
          }

          return yield* startJob({
            recapId: existing.id,
            repoId: params.repoId,
            period: params.period,
            periodStart: params.periodStart,
            periodEnd: params.periodEnd,
            trigger: "manual",
            previousOverview,
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
      });

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Trim PR body to ~2KB so the bundle stays bounded. */
function truncateBody(body: string): string {
  const MAX = 2000;
  if (body.length <= MAX) return body;
  return `${body.slice(0, MAX)}\n\n[…truncated…]`;
}
