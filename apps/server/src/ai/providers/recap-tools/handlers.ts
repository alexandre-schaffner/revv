// ─── recap-tools/handlers ────────────────────────────────────────────────────
//
// Shared handler implementations for the recap MCP tools. Used by:
//   • In-process Claude SDK adapter (recap-tools/index.ts)
//   • Future HTTP MCP route for opencode parity
//
// All writes hit `projectRecaps` directly via Drizzle so we don't need an
// Effect runtime inside the agent's call path. Each handler is one atomic
// transaction; replays are idempotent.

import type { ProjectRecap, RecapSummaryStats } from "@revv/shared";
import { eq } from "drizzle-orm";
import { projectRecaps } from "../../../db/schema/index";
import type {
  CompleteRecapInput,
  GetRecapStateInput,
  GetRepoContextInput,
  RecapToolHandler,
  RecapToolResult,
  SetRecapOverviewInput,
} from "./spec";

function ok(text: string): RecapToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string): RecapToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ── Read tools ───────────────────────────────────────────────────────────────

export const getRecapStateHandler: RecapToolHandler<GetRecapStateInput> = async (ctx) => {
  // The orchestrator already loaded the source bundle when the job
  // started; we just hand it to the agent. This shape is the structured
  // counterpart to "here are all the PRs you need to recap." Agents read
  // this first, every run, including resumes.
  const payload = {
    recapId: ctx.recapId,
    repoId: ctx.sourceBundle.repoId,
    repoFullName: ctx.sourceBundle.repoFullName,
    period: ctx.sourceBundle.period,
    periodStart: ctx.sourceBundle.periodStart,
    periodEnd: ctx.sourceBundle.periodEnd,
    stats: ctx.sourceBundle.stats,
    prs: ctx.sourceBundle.prs,
    instructions:
      "Read the PRs above. Each row has author, branches, +/- stats, a body excerpt, and (when available) a walkthrough summary + sentiment + risk + 9-axis context. After processing, call set_recap_overview ONCE with a markdown body, the PR ids you included, the walkthrough ids you incorporated, and the pre-aggregated stats. Finally call complete_recap. Do not call other tools.",
  };
  return ok(JSON.stringify(payload));
};

export const getRepoContextHandler: RecapToolHandler<GetRepoContextInput> = async (ctx, input) => {
  const wanted = input.period ?? null;
  const limit = input.limit ?? 3;
  const filtered: ReadonlyArray<ProjectRecap> = wanted
    ? ctx.priorRecaps.filter((r) => r.period === wanted)
    : ctx.priorRecaps;
  const slice = filtered.slice(0, limit);
  if (slice.length === 0) {
    return ok(
      JSON.stringify({
        priorRecaps: [],
        instructions:
          "No prior recaps exist for this repo yet. You are writing the first one; lean on the source PRs alone.",
      }),
    );
  }
  return ok(
    JSON.stringify({
      priorRecaps: slice.map((r) => ({
        id: r.id,
        period: r.period,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        completedAt: r.completedAt,
        overview: r.overview,
        stats: r.summaryStats,
      })),
      instructions:
        "Prior recaps for this repo. Use them for rolling continuity — call out themes that persist, follow-throughs on issues flagged previously, or shifts in direction. Don't restate; build on.",
    }),
  );
};

// ── Write tool ───────────────────────────────────────────────────────────────

export const setRecapOverviewHandler: RecapToolHandler<SetRecapOverviewInput> = async (
  ctx,
  input,
) => {
  // Validate that the source_pr_ids referenced are real members of the
  // bundle. The orchestrator generated the bundle from the DB query; any
  // id outside it is the agent hallucinating, so we reject loudly.
  const knownPrIds = new Set(ctx.sourceBundle.prs.map((p) => p.id));
  const badPrIds = input.source_pr_ids.filter((id) => !knownPrIds.has(id));
  if (badPrIds.length > 0) {
    return err(
      `Error: source_pr_ids includes ids that aren't in this period: ${badPrIds.join(", ")}. Use only ids from get_recap_state.`,
    );
  }

  // Same for walkthroughs.
  const knownWtIds = new Set(
    ctx.sourceBundle.prs.flatMap((p) => (p.walkthrough ? [p.walkthrough.id] : [])),
  );
  const badWtIds = input.source_walkthrough_ids.filter((id) => !knownWtIds.has(id));
  if (badWtIds.length > 0) {
    return err(
      `Error: source_walkthrough_ids includes ids not in this period: ${badWtIds.join(", ")}. Use only ids from get_recap_state.`,
    );
  }

  // Map the agent's flat stats object into our nested RecapSummaryStats shape.
  const stats: RecapSummaryStats = {
    prCount: input.stats.pr_count,
    mergedCount: input.stats.merged_count,
    closedCount: input.stats.closed_count,
    authorCount: input.stats.author_count,
    riskBreakdown: {
      low: input.stats.risk_low,
      medium: input.stats.risk_medium,
      high: input.stats.risk_high,
    },
    walkthroughsMissingCount: input.stats.walkthroughs_missing_count,
  };

  try {
    ctx.db
      .update(projectRecaps)
      .set({
        overview: input.overview,
        sourcePrIds: JSON.stringify(input.source_pr_ids),
        sourceWalkthroughIds: JSON.stringify(input.source_walkthrough_ids),
        summaryStats: JSON.stringify(stats),
      })
      .where(eq(projectRecaps.id, ctx.recapId))
      .run();
  } catch (e) {
    return err(
      `Error: failed to persist recap overview: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return ok(
    "Overview persisted. Call complete_recap now to signal you're done — the orchestrator will mark the recap complete.",
  );
};

// ── Validation gate ──────────────────────────────────────────────────────────

export const completeRecapHandler: RecapToolHandler<CompleteRecapInput> = async (ctx) => {
  // Re-read to confirm the agent did call set_recap_overview before this.
  const row = ctx.db
    .select({
      overview: projectRecaps.overview,
      sourcePrIds: projectRecaps.sourcePrIds,
    })
    .from(projectRecaps)
    .where(eq(projectRecaps.id, ctx.recapId))
    .get();
  if (!row) {
    return err(`Error: recap ${ctx.recapId} not found.`);
  }
  if (!row.overview || row.overview.trim().length === 0) {
    return err(
      "Error: overview is empty. Call set_recap_overview first with a non-empty markdown body, then complete_recap.",
    );
  }
  let sourcePrIds: unknown;
  try {
    sourcePrIds = JSON.parse(row.sourcePrIds);
  } catch {
    sourcePrIds = [];
  }
  if (!Array.isArray(sourcePrIds) || sourcePrIds.length === 0) {
    return err(
      "Error: source_pr_ids must include at least one PR. The recap describes what shipped — if nothing shipped, the scheduler should not have queued this job.",
    );
  }
  // Notify the orchestrator that the validation gate passed. The actual
  // status transition is performed by the orchestrator, not here — agent
  // never writes status (CLAUDE.md invariant #11).
  ctx.onCompleted();
  return ok("Recap complete. The orchestrator will transition status. You may stop.");
};
