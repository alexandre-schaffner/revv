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
  CommitRecapOverviewInput,
  CompleteRecapInput,
  GetPrDiffInput,
  GetRecapStateInput,
  GetRepoContextInput,
  ListOpenPrsInput,
  RecapSourcePrDiff,
  RecapToolHandler,
  RecapToolResult,
} from "./spec";

/** Default page size for `list_open_prs`. Small enough that 20 PRs split into
 *  ≤4 pages, each well under the MCP response budget. */
const OPEN_PRS_DEFAULT_PAGE_SIZE = 5;
/** Hard cap on a single `list_open_prs` page — matches the schema. */
const OPEN_PRS_MAX_PAGE_SIZE = 20;

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
  const openPrsTotal = ctx.sourceBundle.openPrs.length;
  const payload = {
    recapId: ctx.recapId,
    repoId: ctx.sourceBundle.repoId,
    repoFullName: ctx.sourceBundle.repoFullName,
    period: ctx.sourceBundle.period,
    periodStart: ctx.sourceBundle.periodStart,
    periodEnd: ctx.sourceBundle.periodEnd,
    stats: ctx.sourceBundle.stats,
    prs: ctx.sourceBundle.prs,
    openPrsTotal,
    openPrsPageSize: OPEN_PRS_DEFAULT_PAGE_SIZE,
    previousOverview,
    instructions:
      `Read the archived PRs above (the \`prs\` array). Each row has author, branches, +/- stats, a body excerpt, and (when available) a walkthrough summary + sentiment + risk + 9-axis context. For PRs where \`walkthrough\` is null, call get_pr_diff with the PR's \`id\` to fetch the actual file changes (per-file status, additions, deletions, unified patch text) — do this for each PR you want to describe in detail before you start composing. Open PRs are NOT inlined here to keep this payload small — there are ${openPrsTotal} of them, capped at the 20 most recently updated. Fetch them via list_open_prs (start with offset=0, default page size ${OPEN_PRS_DEFAULT_PAGE_SIZE}) and keep paging while \`nextOffset\` is non-null. Use those rows to write the 'Active work' section after 'What shipped'. WRITE THE COMPLETE RECAP AS YOUR VISIBLE ASSISTANT RESPONSE — the user watches it stream in live as you type, and the server reads what you wrote when you commit. No preamble, no "Here is the recap" framing, no inter-tool commentary — start with the first heading and go. If you call ANY tool while composing, the buffered text resets, so finish your reads first. When the markdown is complete, call commit_recap_overview ONCE with just the metadata (the PR ids you included, the walkthrough ids you incorporated, and the pre-aggregated stats). Finally call complete_recap.` +
      rerunInstructions,
  };
  return ok(JSON.stringify(payload));
};

export const listOpenPrsHandler: RecapToolHandler<ListOpenPrsInput> = async (ctx, input) => {
  // Slice the in-memory bundle — the orchestrator already capped the list at
  // 20 most-recently-updated rows when it built the bundle, so we never page
  // beyond what was loaded at job start.
  const all = ctx.sourceBundle.openPrs;
  const total = all.length;
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(
    OPEN_PRS_MAX_PAGE_SIZE,
    Math.max(1, input.limit ?? OPEN_PRS_DEFAULT_PAGE_SIZE),
  );
  if (offset >= total) {
    return ok(
      JSON.stringify({
        prs: [],
        total,
        offset,
        limit,
        nextOffset: null,
        instructions:
          total === 0
            ? "No open PRs in this repo. Skip the 'Active work' section entirely."
            : "You've already read every page. Stop calling list_open_prs and move on to composing the recap.",
      }),
    );
  }
  const end = Math.min(offset + limit, total);
  const slice = all.slice(offset, end);
  const nextOffset = end < total ? end : null;
  return ok(
    JSON.stringify({
      prs: slice,
      total,
      offset,
      limit,
      nextOffset,
      instructions:
        nextOffset === null
          ? `Final page: rows ${offset}..${end - 1} of ${total}. You've now seen every open PR; do not call list_open_prs again. Reference these ids in the 'Active work' section.`
          : `Rows ${offset}..${end - 1} of ${total}. Call list_open_prs again with offset=${nextOffset} to get the next page, then continue.`,
    }),
  );
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

// ── Atomic commit tool ───────────────────────────────────────────────────────

export const commitRecapOverviewHandler: RecapToolHandler<CommitRecapOverviewInput> = async (
  ctx,
  input,
) => {
  // Read the markdown body from the in-memory buffer the orchestrator's
  // stream consumer has been appending text-deltas into. The agent's
  // visible response IS the recap — the model never re-serialises it
  // here as a tool argument. (CLAUDE.md invariant #2: the DB write
  // still happens inside an MCP handler; the buffer is just a side
  // channel from the streaming consumer.)
  const overview = ctx.textBuffer.current.trim();
  if (overview.length === 0) {
    return err(
      "Error: no recap text has been buffered. Write the recap markdown as your visible assistant response BEFORE calling commit_recap_overview — the server reads what you typed. If you called a tool while composing, the buffer was reset; re-write the recap as one continuous response then call this tool again.",
    );
  }

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
        overview,
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
  ctx.emit({ type: "overview", data: { overview } });
  ctx.emit({ type: "phase", data: { phase: "finalizing", message: "Finalizing recap…" } });
  return ok(
    "Overview persisted. Call complete_recap now to signal you're done — the orchestrator will mark the recap complete.",
  );
};

// ── Validation gate ──────────────────────────────────────────────────────────

export const completeRecapHandler: RecapToolHandler<CompleteRecapInput> = async (ctx) => {
  // Re-read to confirm the agent did call commit_recap_overview before this.
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
      "Error: overview is empty. Call commit_recap_overview first — and before that, write the recap markdown as your visible assistant response so the server has text to persist.",
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

// ── Lazy diff tool ───────────────────────────────────────────────────────────

export const getPrDiffHandler: RecapToolHandler<GetPrDiffInput> = async (ctx, input) => {
  const allPrs = [...ctx.sourceBundle.prs, ...ctx.sourceBundle.openPrs];
  const pr = allPrs.find((p) => p.id === input.pr_id);
  if (!pr) {
    return err(
      `PR id "${input.pr_id}" is not in this recap's source bundle. Use only ids from the \`prs\` array returned by get_recap_state.`,
    );
  }

  let diff: RecapSourcePrDiff | null;
  try {
    diff = await ctx.getPrDiff(input.pr_id);
  } catch (e) {
    return err(
      `Diff fetch failed for ${input.pr_id}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (diff === null) {
    return err(
      `Diff unavailable for PR "${input.pr_id}". Fall back to describing it from title, body, and +/- counts.`,
    );
  }

  return ok(
    JSON.stringify({
      pr_id: input.pr_id,
      diff,
      instructions:
        "Diff loaded. Read the `files[].patch` blocks (status, additions, deletions, unified diff) to describe what the change does. Honor any `diff.note` (truncation hints) — don't claim coverage of files you weren't shown. When `diff.source` is `'unavailable'`, fall back to title + body + +/- counts and say so.",
    }),
  );
};
