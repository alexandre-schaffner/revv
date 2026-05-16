// ─── ProjectRecapService ────────────────────────────────────────────────────
//
// Thin Drizzle adapter for the `project_recaps` table. Scope mirrors
// WalkthroughService:
//
//   • Orchestrator lifecycle (createPartial, setStatus, supersede,
//     incrementResumeAttempts, listGenerating).
//   • Read-side (getById, listForRepo, getLatestForRepo,
//     findActiveForPeriod).
//   • Content writes that come from MCP tool handlers (setOverview).
//
// Per CLAUDE.md invariants #2 and #11: only `ProjectRecapJobs` calls
// `setStatus`. Agents reach the DB only via the recap MCP tool surface.

import type {
  ProjectRecap,
  ProjectRecapStatus,
  ProjectRecapSummary,
  RecapPeriod,
  RecapSummaryStats,
} from "@revv/shared";
import { EMPTY_RECAP_STATS } from "@revv/shared";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { projectRecaps } from "../db/schema/index";
import { RecapNotFoundError, ValidationError } from "../domain/errors";
import { DbService } from "./Db";

function parseStats(json: string): RecapSummaryStats {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object") return EMPTY_RECAP_STATS;
    const o = parsed as Partial<RecapSummaryStats>;
    const breakdown =
      o.riskBreakdown && typeof o.riskBreakdown === "object"
        ? {
            low: typeof o.riskBreakdown.low === "number" ? o.riskBreakdown.low : 0,
            medium: typeof o.riskBreakdown.medium === "number" ? o.riskBreakdown.medium : 0,
            high: typeof o.riskBreakdown.high === "number" ? o.riskBreakdown.high : 0,
          }
        : EMPTY_RECAP_STATS.riskBreakdown;
    return {
      prCount: typeof o.prCount === "number" ? o.prCount : 0,
      mergedCount: typeof o.mergedCount === "number" ? o.mergedCount : 0,
      closedCount: typeof o.closedCount === "number" ? o.closedCount : 0,
      authorCount: typeof o.authorCount === "number" ? o.authorCount : 0,
      riskBreakdown: breakdown,
      walkthroughsMissingCount:
        typeof o.walkthroughsMissingCount === "number" ? o.walkthroughsMissingCount : 0,
    };
  } catch {
    return EMPTY_RECAP_STATS;
  }
}

function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function rowToRecap(row: typeof projectRecaps.$inferSelect): ProjectRecap {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    period: row.period as RecapPeriod,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    overview: row.overview,
    status: row.status as ProjectRecapStatus,
    supersededBy: row.supersededBy ?? null,
    generatedAt: row.generatedAt,
    completedAt: row.completedAt ?? null,
    modelUsed: row.modelUsed ?? null,
    sourcePrIds: parseStringArray(row.sourcePrIds),
    sourceWalkthroughIds: parseStringArray(row.sourceWalkthroughIds),
    summaryStats: parseStats(row.summaryStats),
  };
}

function rowToSummary(row: typeof projectRecaps.$inferSelect): ProjectRecapSummary {
  const sourcePrIds = parseStringArray(row.sourcePrIds);
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    period: row.period as RecapPeriod,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status as ProjectRecapStatus,
    generatedAt: row.generatedAt,
    completedAt: row.completedAt ?? null,
    sourcePrCount: sourcePrIds.length,
    summaryStats: parseStats(row.summaryStats),
  };
}

export interface CreatePartialRecapParams {
  readonly repositoryId: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Caller-provided id when the orchestrator wants to thread one (resume path). */
  readonly id?: string;
  /** Provided up-front by the scheduler so it's queryable before the agent runs. */
  readonly modelUsed?: string;
}

export interface SetRecapOverviewParams {
  readonly recapId: string;
  readonly overview: string;
  readonly sourcePrIds: ReadonlyArray<string>;
  readonly sourceWalkthroughIds: ReadonlyArray<string>;
  readonly stats: RecapSummaryStats;
  readonly modelUsed?: string;
  readonly tokenUsage?: Record<string, number>;
}

export interface ListForRepoParams {
  readonly period?: RecapPeriod;
  /** Cursor: the generatedAt of the last row from the previous page. */
  readonly cursor?: string;
  readonly limit?: number;
  /** Include superseded rows. Default false: UI shows the current row only. */
  readonly includeSuperseded?: boolean;
}

export interface ListForRepoResult {
  readonly recaps: ReadonlyArray<ProjectRecapSummary>;
  readonly nextCursor: string | null;
}

export const DEFAULT_RECAP_PAGE_LIMIT = 30;
export const MAX_RECAP_PAGE_LIMIT = 100;

export class ProjectRecapService extends Context.Tag("ProjectRecapService")<
  ProjectRecapService,
  {
    /**
     * Insert a recap row at `status='generating'`. Returns the row.
     *
     * Note on uniqueness: there's no DB-level unique on (repo, period,
     * periodStart) — regenerates need to coexist with the old superseded row
     * until the new one finishes. The orchestrator's `startJob` mutex
     * enforces application-level uniqueness instead.
     */
    readonly createPartial: (
      params: CreatePartialRecapParams,
    ) => Effect.Effect<ProjectRecap, ValidationError, DbService>;

    readonly getById: (
      id: string,
    ) => Effect.Effect<ProjectRecap, RecapNotFoundError | ValidationError, DbService>;

    /** Look up a complete-or-generating recap for a specific period. */
    readonly findActiveForPeriod: (
      repoId: string,
      period: RecapPeriod,
      periodStart: string,
    ) => Effect.Effect<ProjectRecap | null, ValidationError, DbService>;

    readonly listForRepo: (
      repoId: string,
      params: ListForRepoParams,
    ) => Effect.Effect<ListForRepoResult, ValidationError, DbService>;

    /**
     * Most-recent complete recaps for a repo. Used by the walkthrough agent's
     * `get_repo_context` MCP read tool. Returns at most `limit` rows ordered
     * by `completedAt DESC`. Filters by `period` if provided.
     */
    readonly getLatestForRepo: (
      repoId: string,
      params: { period?: RecapPeriod; limit?: number },
    ) => Effect.Effect<ReadonlyArray<ProjectRecap>, ValidationError, DbService>;

    /**
     * Single content write performed by the recap agent via the MCP
     * `set_recap_overview` tool. Stamps the overview + provenance + stats
     * in one transaction. Idempotent on `recapId` — replays update the
     * same row.
     */
    readonly setOverview: (
      params: SetRecapOverviewParams,
    ) => Effect.Effect<void, RecapNotFoundError | ValidationError, DbService>;

    /**
     * Orchestrator-only status transition. Stamps `completedAt = now()`
     * on the `'complete'` transition (single-writer per invariant #11,
     * mirrors the walkthrough pattern).
     */
    readonly setStatus: (
      recapId: string,
      status: ProjectRecapStatus,
      options?: { tokenUsage?: Record<string, number>; modelUsed?: string },
    ) => Effect.Effect<void, never, DbService>;

    /** Mark `oldId` superseded with `supersededBy = newId`. */
    readonly supersede: (oldId: string, newId: string) => Effect.Effect<void, never, DbService>;

    /**
     * Enumerate rows still in `status='generating'` for boot-time resume.
     */
    readonly listGenerating: () => Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly repositoryId: string;
        readonly period: RecapPeriod;
        readonly periodStart: string;
        readonly periodEnd: string;
        readonly resumeAttempts: number;
      }>,
      never,
      DbService
    >;

    readonly incrementResumeAttempts: (recapId: string) => Effect.Effect<number, never, DbService>;
  }
>() {}

export const ProjectRecapServiceLive = Layer.succeed(ProjectRecapService, {
  createPartial: (params) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const id = params.id ?? crypto.randomUUID();
      const generatedAt = new Date().toISOString();

      const inserted = yield* Effect.try({
        try: () => {
          const values: typeof projectRecaps.$inferInsert = {
            id,
            repositoryId: params.repositoryId,
            period: params.period,
            periodStart: params.periodStart,
            periodEnd: params.periodEnd,
            overview: "",
            status: "generating",
            generatedAt,
            tokenUsage: "{}",
            sourcePrIds: "[]",
            sourceWalkthroughIds: "[]",
            summaryStats: "{}",
            resumeAttempts: 0,
          };
          if (params.modelUsed !== undefined) values.modelUsed = params.modelUsed;
          db.insert(projectRecaps).values(values).run();
          const row = db.select().from(projectRecaps).where(eq(projectRecaps.id, id)).get();
          if (!row) {
            throw new Error(`Failed to read back inserted recap ${id}`);
          }
          return rowToRecap(row);
        },
        catch: (e) => new ValidationError({ message: `createPartial: ${String(e)}` }),
      });

      return inserted;
    }),

  getById: (id) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = yield* Effect.try({
        try: () => db.select().from(projectRecaps).where(eq(projectRecaps.id, id)).get(),
        catch: (e) => new ValidationError({ message: `getById: ${String(e)}` }),
      });
      if (!row) {
        return yield* Effect.fail(new RecapNotFoundError({ recapId: id }));
      }
      return rowToRecap(row);
    }),

  findActiveForPeriod: (repoId, period, periodStart) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      return yield* Effect.try({
        try: () => {
          const row = db
            .select()
            .from(projectRecaps)
            .where(
              and(
                eq(projectRecaps.repositoryId, repoId),
                eq(projectRecaps.period, period),
                eq(projectRecaps.periodStart, periodStart),
                // Active = anything that hasn't been superseded. Even an
                // `error` row counts as active here — the scheduler should
                // not silently retry it on the next tick, since
                // `resumePending` handles bounded retries.
              ),
            )
            .orderBy(desc(projectRecaps.generatedAt))
            .all();
          // Prefer rows whose `supersededBy` is null. There can be many
          // historical rows if the user regenerated repeatedly; only one
          // is the "current" one.
          const current = row.find((r) => r.supersededBy === null);
          return current ? rowToRecap(current) : null;
        },
        catch: (e) => new ValidationError({ message: `findActiveForPeriod: ${String(e)}` }),
      });
    }),

  listForRepo: (repoId, params) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const limit = Math.min(
        Math.max(1, params.limit ?? DEFAULT_RECAP_PAGE_LIMIT),
        MAX_RECAP_PAGE_LIMIT,
      );

      return yield* Effect.try({
        try: () => {
          const conditions = [eq(projectRecaps.repositoryId, repoId)];
          if (params.period !== undefined) {
            conditions.push(eq(projectRecaps.period, params.period));
          }
          if (params.cursor !== undefined) {
            conditions.push(lt(projectRecaps.generatedAt, params.cursor));
          }
          if (!params.includeSuperseded) {
            conditions.push(isNull(projectRecaps.supersededBy));
          }

          const rows = db
            .select()
            .from(projectRecaps)
            .where(and(...conditions))
            .orderBy(desc(projectRecaps.generatedAt))
            .limit(limit + 1)
            .all();

          const hasMore = rows.length > limit;
          const trimmed = hasMore ? rows.slice(0, limit) : rows;
          const lastRow = trimmed[trimmed.length - 1];
          const nextCursor = hasMore && lastRow ? lastRow.generatedAt : null;
          return {
            recaps: trimmed.map(rowToSummary),
            nextCursor,
          };
        },
        catch: (e) => new ValidationError({ message: `listForRepo: ${String(e)}` }),
      });
    }),

  getLatestForRepo: (repoId, params) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const limit = Math.min(Math.max(1, params.limit ?? 3), 10);
      return yield* Effect.try({
        try: () => {
          const conditions = [
            eq(projectRecaps.repositoryId, repoId),
            eq(projectRecaps.status, "complete"),
          ];
          if (params.period !== undefined) {
            conditions.push(eq(projectRecaps.period, params.period));
          }
          const rows = db
            .select()
            .from(projectRecaps)
            .where(and(...conditions))
            .orderBy(desc(projectRecaps.completedAt))
            .limit(limit)
            .all();
          return rows.map(rowToRecap);
        },
        catch: (e) => new ValidationError({ message: `getLatestForRepo: ${String(e)}` }),
      });
    }),

  setOverview: (params) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      yield* Effect.try({
        try: () => {
          const exists = db
            .select({ id: projectRecaps.id })
            .from(projectRecaps)
            .where(eq(projectRecaps.id, params.recapId))
            .get();
          if (!exists) {
            throw new Error(`recap ${params.recapId} not found`);
          }
          const patch: Partial<typeof projectRecaps.$inferInsert> = {
            overview: params.overview,
            sourcePrIds: JSON.stringify(params.sourcePrIds),
            sourceWalkthroughIds: JSON.stringify(params.sourceWalkthroughIds),
            summaryStats: JSON.stringify(params.stats),
          };
          if (params.modelUsed !== undefined) patch.modelUsed = params.modelUsed;
          if (params.tokenUsage !== undefined) {
            patch.tokenUsage = JSON.stringify(params.tokenUsage);
          }
          db.update(projectRecaps).set(patch).where(eq(projectRecaps.id, params.recapId)).run();
        },
        catch: (e) => {
          const msg = String(e);
          if (msg.includes("not found")) {
            return new RecapNotFoundError({ recapId: params.recapId });
          }
          return new ValidationError({ message: `setOverview: ${msg}` });
        },
      });
    }),

  setStatus: (recapId, status, options) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const completedAtPatch =
        status === "complete" ? { completedAt: new Date().toISOString() } : {};
      const tokenPatch = options?.tokenUsage
        ? { tokenUsage: JSON.stringify(options.tokenUsage) }
        : {};
      const modelPatch = options?.modelUsed !== undefined ? { modelUsed: options.modelUsed } : {};
      yield* Effect.try({
        try: () =>
          db
            .update(projectRecaps)
            .set({ status, ...completedAtPatch, ...tokenPatch, ...modelPatch })
            .where(eq(projectRecaps.id, recapId))
            .run(),
        catch: (e) => new ValidationError({ message: `setStatus: ${String(e)}` }),
      });
    }).pipe(Effect.catchAll(() => Effect.void)),

  supersede: (oldId, newId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      yield* Effect.try({
        try: () =>
          db
            .update(projectRecaps)
            .set({ status: "superseded", supersededBy: newId })
            .where(eq(projectRecaps.id, oldId))
            .run(),
        catch: (e) => new ValidationError({ message: `supersede: ${String(e)}` }),
      });
    }).pipe(Effect.catchAll(() => Effect.void)),

  listGenerating: () =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = yield* Effect.try({
        try: () =>
          db
            .select({
              id: projectRecaps.id,
              repositoryId: projectRecaps.repositoryId,
              period: projectRecaps.period,
              periodStart: projectRecaps.periodStart,
              periodEnd: projectRecaps.periodEnd,
              resumeAttempts: projectRecaps.resumeAttempts,
            })
            .from(projectRecaps)
            .where(eq(projectRecaps.status, "generating"))
            .all(),
        catch: (e) => new ValidationError({ message: `listGenerating: ${String(e)}` }),
      });
      return rows.map((r) => ({
        id: r.id,
        repositoryId: r.repositoryId,
        period: r.period as RecapPeriod,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        resumeAttempts: r.resumeAttempts,
      }));
    }).pipe(Effect.catchAll(() => Effect.succeed([] as never[]))),

  incrementResumeAttempts: (recapId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const next = yield* Effect.try({
        try: () => {
          const row = db
            .select({ resumeAttempts: projectRecaps.resumeAttempts })
            .from(projectRecaps)
            .where(eq(projectRecaps.id, recapId))
            .get();
          const value = (row?.resumeAttempts ?? 0) + 1;
          db.update(projectRecaps)
            .set({ resumeAttempts: value })
            .where(eq(projectRecaps.id, recapId))
            .run();
          return value;
        },
        catch: (e) => new ValidationError({ message: `incrementResumeAttempts: ${String(e)}` }),
      });
      return next;
    }).pipe(Effect.catchAll(() => Effect.succeed(0))),
});
