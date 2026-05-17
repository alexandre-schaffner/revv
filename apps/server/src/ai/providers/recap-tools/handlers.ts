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
  AppendRecapChunkInput,
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
  const previousOverview = ctx.sourceBundle.previousOverview;
  const rerunInstructions = previousOverview
    ? " A `previousOverview` is included — it's the recap you wrote earlier for this same window. The window has since rolled forward (new PRs closed, walkthroughs landed). Update that overview in place: keep what's still accurate, refresh the stats, fold in new PRs, and adjust narrative where the picture changed. Do NOT restart from scratch and do NOT mention that you're updating — the reader sees only the final overview."
    : "";
  const payload = {
    recapId: ctx.recapId,
    repoId: ctx.sourceBundle.repoId,
    repoFullName: ctx.sourceBundle.repoFullName,
    period: ctx.sourceBundle.period,
    periodStart: ctx.sourceBundle.periodStart,
    periodEnd: ctx.sourceBundle.periodEnd,
    stats: ctx.sourceBundle.stats,
    prs: ctx.sourceBundle.prs,
    openPrs: ctx.sourceBundle.openPrs,
    previousOverview,
    instructions:
      "Read the archived PRs above (the `prs` array). Each row has author, branches, +/- stats, a body excerpt, and (when available) a walkthrough summary + sentiment + risk + 9-axis context. For PRs where `walkthrough` is null, a `diff` object is provided with the actual file changes — read those `files[].patch` blocks (status, additions, deletions, unified diff) to describe what the change does. The `diff.source` field tells you where the bytes came from (`'cache'`, `'github'`, or `'unavailable'`); when it's `'unavailable'`, fall back to title + body + +/- counts. Honor any `diff.note` (truncation hints) and don't claim to have read more than you did. Also review the `openPrs` array for currently open PRs — use these to write an 'Active work' section after 'What shipped'. As you compose each section, call append_recap_chunk to stream it live. Then call set_recap_overview ONCE with the complete markdown body, the PR ids you included, the walkthrough ids you incorporated, and the pre-aggregated stats. Finally call complete_recap." +
      rerunInstructions,
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

// ── Streaming write tool ─────────────────────────────────────────────────────

export const appendRecapChunkHandler: RecapToolHandler<AppendRecapChunkInput> = async (
  ctx,
  input,
) => {
  // Append the streamed chunk to the overview column so it survives
  // client reconnects. The final set_recap_overview will overwrite
  // with the authoritative assembled markdown + metadata.
  const row = ctx.db
    .select({ overview: projectRecaps.overview })
    .from(projectRecaps)
    .where(eq(projectRecaps.id, ctx.recapId))
    .get();
  if (!row) {
    return err(`Error: recap ${ctx.recapId} not found.`);
  }

  const nextOverview = (row.overview ?? "") + input.chunk;
  try {
    ctx.db
      .update(projectRecaps)
      .set({ overview: nextOverview })
      .where(eq(projectRecaps.id, ctx.recapId))
      .run();
  } catch (e) {
    return err(
      `Error: failed to append recap chunk: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Map the agent's section hint to a RecapStreamPhase.
  const sectionMap: Record<string, "shipped" | "active_work" | "project_state" | "other"> = {
    shipped: "shipped",
    active_work: "active_work",
    project_state: "project_state",
    other: "other",
  };
  const section = input.section ? (sectionMap[input.section] ?? "other") : undefined;

  ctx.emit({ type: "chunk", data: { text: input.chunk, ...(section ? { section } : {}) } });
  if (section) {
    const phaseMessages: Record<string, string> = {
      shipped: "Writing: What shipped…",
      active_work: "Writing: Active work…",
      project_state: "Writing: Project state…",
      other: "Writing recap…",
    };
    ctx.emit({
      type: "phase",
      data: { phase: section, message: phaseMessages[section] ?? "Writing recap…" },
    });
  }

  return ok(
    "Chunk appended. Continue streaming or call set_recap_overview with the final markdown.",
  );
};

// ── Atomic write tool ────────────────────────────────────────────────────────

export const setRecapOverviewHandler: RecapToolHandler<SetRecapOverviewInput> = async (
  ctx,
  input,
) => {
  // Validate that the source_pr_ids referenced are real members of the
  // bundle. The orchestrator generated the bundle from the DB query; any
  // id outside it is the agent hallucinating, so we reject loudly. Both
  // archived and open PRs are valid sources — a "nothing shipped, only
  // active work" recap legitimately references open PR ids.
  const allBundlePrs = [...ctx.sourceBundle.prs, ...ctx.sourceBundle.openPrs];
  const knownPrIds = new Set(allBundlePrs.map((p) => p.id));
  const badPrIds = input.source_pr_ids.filter((id) => !knownPrIds.has(id));
  if (badPrIds.length > 0) {
    return err(
      `Error: source_pr_ids includes ids that aren't in this period: ${badPrIds.join(", ")}. Use only ids from get_recap_state.`,
    );
  }

  // Same for walkthroughs.
  const knownWtIds = new Set(
    allBundlePrs.flatMap((p) => (p.walkthrough ? [p.walkthrough.id] : [])),
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
  ctx.emit({ type: "overview", data: { overview: input.overview } });
  ctx.emit({ type: "phase", data: { phase: "finalizing", message: "Finalizing recap…" } });
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
      "Error: source_pr_ids must include at least one PR. When nothing shipped, reference the open PRs you wrote about in the 'Active work' section.",
    );
  }
  // Notify the orchestrator that the validation gate passed. The actual
  // status transition is performed by the orchestrator, not here — agent
  // never writes status (CLAUDE.md invariant #11).
  ctx.onCompleted();
  ctx.emit({ type: "done", data: { recapId: ctx.recapId } });
  return ok("Recap complete. The orchestrator will transition status. You may stop.");
};
