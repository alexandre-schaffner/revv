// ─── recap-tools/handlers ────────────────────────────────────────────────────
//
// Shared handler implementations for the recap MCP tools. Used by:
//   • In-process Claude SDK adapter (recap-tools/index.ts)
//   • Future HTTP MCP route for opencode parity
//
// All writes hit `projectRecaps` directly via Drizzle so we don't need an
// Effect runtime inside the agent's call path. Each handler is one atomic
// transaction; replays are idempotent.

import { randomUUID } from "node:crypto";
import type { ProjectRecap, RecapPrEntry, RecapThemeSummary } from "@revv/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  projectRecaps,
  pullRequests,
  recapPrEntries,
  recapThemeSummaries,
  remoteUsers,
} from "../../../db/schema/index";
import type {
  AddPrEntryInput,
  CompleteRecapInput,
  GetPrDiffInput,
  GetRecapStateInput,
  GetRepoContextInput,
  ListOpenPrsInput,
  RecapSourcePrDiff,
  RecapToolContext,
  RecapToolHandler,
  RecapToolResult,
  SetLedeInput,
  SetThemeSummaryInput,
} from "./spec";

/** Lowercase the theme, trim, collapse internal whitespace. Single source of
 *  truth so `add_pr_entry` and `set_theme_summary` join on the same key. */
function normalizeTheme(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

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
  // Surface entries written in a prior partial run so the agent can pick up
  // where it left off rather than start over. Idempotent upserts on
  // (recap_id, pr_id) mean re-adding existing entries is safe, but skipping
  // already-covered PRs keeps the run cheaper.
  const priorEntries = ctx.db
    .select({
      prId: recapPrEntries.prId,
      theme: recapPrEntries.theme,
      verb: recapPrEntries.verb,
      position: recapPrEntries.position,
    })
    .from(recapPrEntries)
    .where(eq(recapPrEntries.recapId, ctx.recapId))
    .all();
  const priorThemeSummaries = ctx.db
    .select({
      theme: recapThemeSummaries.theme,
      summary: recapThemeSummaries.summary,
    })
    .from(recapThemeSummaries)
    .where(eq(recapThemeSummaries.recapId, ctx.recapId))
    .all();
  const priorLedeRow = ctx.db
    .select({ lede: projectRecaps.lede })
    .from(projectRecaps)
    .where(eq(projectRecaps.id, ctx.recapId))
    .get();

  const priorLede = priorLedeRow?.lede?.trim() ?? "";
  const rerunInstructions =
    priorEntries.length > 0 || priorLede.length > 0 || priorThemeSummaries.length > 0
      ? ` A prior partial run wrote ${priorEntries.length} entries${priorLede ? " and a lede" : ""}${priorThemeSummaries.length > 0 ? ` and ${priorThemeSummaries.length} theme summaries` : ""}. Treat that as a draft: keep what's still accurate (re-call add_pr_entry / set_theme_summary with the same key only if you want to change the row), and fill in the gaps. You don't need to mention you're resuming.`
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
    priorEntries,
    priorThemeSummaries,
    priorLede: priorLede || null,
    instructions:
      `Read the archived PRs above (the \`prs\` array). Each row has author, title, branches, +/- stats, body excerpt, and (when available) a walkthrough summary + sentiment + risk. For PRs without a walkthrough, use \`diffDigest\` — raw patches are not needed. The open-PR list (via list_open_prs) follows the same shape, including \`diffDigest\` for open PRs that lack walkthroughs. Workflow:

      1. Call get_repo_context to see prior recaps for this repo.
      2. Call set_lede ONCE with a tight 1–3 sentence editorial summary of the period (covers shipped headline first, in-flight tail second). Plain text plus optional <strong>/<em>. No markdown.
      3. For each ARCHIVED PR worth including, call add_pr_entry once. Shipped work is the recap's primary record — if the period had archived PRs, you MUST write at least one merged entry per dominant theme. When many archived PRs are similar (e.g. a repeated migration), surface 5–10 representative entries spanning the variety; do NOT skip the cluster. "Skip pure chores" is for typo fixes and version bumps only.
      4. Call list_open_prs and, for each OPEN PR worth surfacing as active work, call add_pr_entry. Reuse the same theme labels as shipped entries when relevant — the UI renders open entries as an "In progress" subgroup inside the matching theme chapter.
      5. add_pr_entry arguments: pr_id, position (your render order, starting at 0, archived entries first), theme (short reusable lowercase noun), verb (past tense for shipped, present tense for open), description (one sentence in matching tense, may use \`backticks\` for code/file paths, NO other markdown), lines_added, lines_removed. The server records whether the PR was archived or open from the source bundle — you don't pass that.
      6. After all add_pr_entry calls, call set_theme_summary ONCE per distinct theme you used — a 1–2 sentence chapter lede that frames what landed in that area. Reuse the same lowercase theme label you passed to add_pr_entry. Keep summaries short (≤ ~35 words) and human; backtick-wrapped code spans are allowed but no other markdown.
      7. Call complete_recap to finalize. The orchestrator stamps summary_stats, source_pr_ids, totals from your entries and transitions status.

      Do NOT emit visible prose between tool calls — there is no streaming text buffer in this pipeline. All content flows through tool arguments.` +
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
            ? "No open PRs in this repo. There is no active work to include — proceed with shipped entries only."
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
          ? `Final page: rows ${offset}..${end - 1} of ${total}. You've now seen every open PR. Use add_pr_entry for the ones worth including as active work — reuse themes from shipped PRs when relevant.`
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
  const recapIds = slice.map((r) => r.id);
  const themeRows =
    recapIds.length > 0
      ? ctx.db
          .select({ recapId: recapPrEntries.recapId, theme: recapPrEntries.theme })
          .from(recapPrEntries)
          .where(inArray(recapPrEntries.recapId, recapIds))
          .all()
      : [];
  const themesByRecapId = new Map<string, string[]>();
  for (const row of themeRows) {
    const existing = themesByRecapId.get(row.recapId);
    if (existing) {
      existing.push(row.theme);
    } else {
      themesByRecapId.set(row.recapId, [row.theme]);
    }
  }
  return ok(
    JSON.stringify({
      priorRecaps: slice.map((r) => ({
        id: r.id,
        period: r.period,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        completedAt: r.completedAt,
        lede: r.lede,
        themes: Array.from(new Set(themesByRecapId.get(r.id) ?? [])),
        stats: r.summaryStats,
      })),
      instructions:
        "Prior recaps for this repo. Use them for rolling continuity — call out themes that persist, follow-throughs on issues flagged previously, or shifts in direction. Don't restate; build on.",
    }),
  );
};

// ── Atomic content writes ────────────────────────────────────────────────────

/**
 * `<strong>` / `<em>` are the only HTML tags allowed in the lede; the UI
 * applies the same allowlist at render time. The handler scrubs everything
 * else here so a non-conforming model emission never reaches storage.
 */
function sanitizeLede(raw: string): string {
  return raw
    .trim()
    .replace(/<(?!\/?(?:strong|em)\b)[^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Fail the call if the recap is no longer `generating` (stopped, superseded, completed).
function requireGenerating(ctx: RecapToolContext, action: string): RecapToolResult | null {
  const row = ctx.db
    .select({ status: projectRecaps.status })
    .from(projectRecaps)
    .where(eq(projectRecaps.id, ctx.recapId))
    .get();
  if (row?.status !== "generating") {
    return err(
      `Recap is no longer generating (status=${row?.status ?? "unknown"}). Aborting ${action}.`,
    );
  }
  return null;
}

export const setLedeHandler: RecapToolHandler<SetLedeInput> = async (ctx, input) => {
  const guard = requireGenerating(ctx, "set_lede");
  if (guard) return guard;

  const lede = sanitizeLede(input.lede);
  if (lede.length === 0) {
    return err(
      "Error: lede was empty after sanitization. Submit 1–3 sentences of plain text; only <strong>/<em> are allowed as inline tags.",
    );
  }

  ctx.db.update(projectRecaps).set({ lede }).where(eq(projectRecaps.id, ctx.recapId)).run();

  ctx.emit({ type: "lede", data: { lede } });
  ctx.emit({
    type: "phase",
    data: { phase: "categorizing", message: "Categorizing pull requests…" },
  });
  return ok(
    "Lede persisted. Now call add_pr_entry once per PR you want in the recap (skip pure chores).",
  );
};

export const addPrEntryHandler: RecapToolHandler<AddPrEntryInput> = async (ctx, input) => {
  const guard = requireGenerating(ctx, "add_pr_entry");
  if (guard) return guard;

  // Validate prId is in the source bundle. Archived PRs are recorded as
  // `pr_state='merged'`, open PRs as `pr_state='open'` — server-derived from
  // which list the id came from. The agent never passes prState directly;
  // this mirrors the "orchestrator owns lifecycle, agents own content"
  // invariant. The UI groups open entries as "In progress" inside the
  // theme chapter, alongside the merged entries.
  const archivedIds = new Set(ctx.sourceBundle.prs.map((p) => p.id));
  const openIds = new Set(ctx.sourceBundle.openPrs.map((p) => p.id));
  if (!archivedIds.has(input.pr_id) && !openIds.has(input.pr_id)) {
    return err(
      `Error: pr_id "${input.pr_id}" is not in this period's source bundle. Use only ids from get_recap_state.prs (archived) or list_open_prs (open).`,
    );
  }
  const prState: "merged" | "open" = archivedIds.has(input.pr_id) ? "merged" : "open";

  const theme = normalizeTheme(input.theme);
  const verb = input.verb.trim().toLowerCase();

  const prRow = ctx.db
    .select({
      title: pullRequests.title,
      externalId: pullRequests.externalId,
      authorLogin: pullRequests.authorLogin,
    })
    .from(pullRequests)
    .where(eq(pullRequests.id, input.pr_id))
    .get();

  // Upsert on (recap_id, pr_id), returning the canonical row in one round-trip.
  // The original `id` is preserved on conflict; the generated one is only used
  // when this is a fresh insert.
  const [persisted] = ctx.db
    .insert(recapPrEntries)
    .values({
      id: randomUUID(),
      recapId: ctx.recapId,
      prId: input.pr_id,
      position: input.position,
      theme,
      verb,
      prTitle: prRow?.title ?? "",
      prExternalId: prRow?.externalId ?? 0,
      prAuthorLogin: prRow?.authorLogin ?? "",
      description: input.description.trim(),
      linesAdded: input.lines_added,
      linesRemoved: input.lines_removed,
      prState,
    })
    .onConflictDoUpdate({
      target: [recapPrEntries.recapId, recapPrEntries.prId],
      set: {
        position: sql`excluded.position`,
        theme: sql`excluded.theme`,
        verb: sql`excluded.verb`,
        prTitle: sql`excluded.pr_title`,
        prExternalId: sql`excluded.pr_external_id`,
        prAuthorLogin: sql`excluded.pr_author_login`,
        description: sql`excluded.description`,
        linesAdded: sql`excluded.lines_added`,
        linesRemoved: sql`excluded.lines_removed`,
        prState: sql`excluded.pr_state`,
      },
    })
    .returning()
    .all();

  if (persisted) {
    const avatarRow = persisted.prAuthorLogin
      ? ctx.db
          .select({ avatarContent: remoteUsers.avatarContent })
          .from(remoteUsers)
          .where(
            and(eq(remoteUsers.provider, "github"), eq(remoteUsers.login, persisted.prAuthorLogin)),
          )
          .get()
      : null;
    const entry: RecapPrEntry = {
      id: persisted.id,
      recapId: persisted.recapId,
      prId: persisted.prId,
      position: persisted.position,
      theme: persisted.theme,
      verb: persisted.verb,
      prTitle: persisted.prTitle,
      prExternalId: persisted.prExternalId,
      prAuthorLogin: persisted.prAuthorLogin,
      prAuthorAvatar: avatarRow?.avatarContent ?? null,
      description: persisted.description,
      linesAdded: persisted.linesAdded,
      linesRemoved: persisted.linesRemoved,
      prState: persisted.prState,
    };
    ctx.emit({ type: "entry", data: { entry } });
  }

  const role = prState === "open" ? "active work" : "shipped";
  return ok(`Entry stored for PR ${input.pr_id} as ${role} under theme "${theme}".`);
};

export const setThemeSummaryHandler: RecapToolHandler<SetThemeSummaryInput> = async (
  ctx,
  input,
) => {
  const guard = requireGenerating(ctx, "set_theme_summary");
  if (guard) return guard;

  const theme = normalizeTheme(input.theme);
  if (theme.length === 0) {
    return err(
      "Error: theme was empty after normalization. Pass the same lowercase noun you used for add_pr_entry.",
    );
  }

  const summary = input.summary.trim().replace(/\s+/g, " ");
  if (summary.length === 0) {
    return err(
      "Error: summary was empty after trim. Submit 1–2 sentences of plain prose; backtick code spans are the only inline markup allowed.",
    );
  }

  const [persisted] = ctx.db
    .insert(recapThemeSummaries)
    .values({
      id: randomUUID(),
      recapId: ctx.recapId,
      theme,
      summary,
    })
    .onConflictDoUpdate({
      target: [recapThemeSummaries.recapId, recapThemeSummaries.theme],
      set: {
        summary: sql`excluded.summary`,
      },
    })
    .returning()
    .all();

  if (persisted) {
    const event: RecapThemeSummary = {
      id: persisted.id,
      recapId: persisted.recapId,
      theme: persisted.theme,
      summary: persisted.summary,
    };
    ctx.emit({ type: "theme_summary", data: { summary: event } });
  }

  return ok(`Theme summary stored for "${theme}".`);
};

// ── Validation gate ──────────────────────────────────────────────────────────

export const completeRecapHandler: RecapToolHandler<CompleteRecapInput> = async (ctx) => {
  const guard = requireGenerating(ctx, "complete_recap");
  if (guard) return guard;

  const ledeRow = ctx.db
    .select({ lede: projectRecaps.lede })
    .from(projectRecaps)
    .where(eq(projectRecaps.id, ctx.recapId))
    .get();
  if (!ledeRow?.lede || ledeRow.lede.trim().length === 0) {
    return err(
      "Error: lede is empty. Call set_lede before complete_recap with a 1–3 sentence editorial summary.",
    );
  }

  const entries = ctx.db
    .select({ prId: recapPrEntries.prId })
    .from(recapPrEntries)
    .where(eq(recapPrEntries.recapId, ctx.recapId))
    .all();

  if (entries.length === 0) {
    return err(
      "Error: no PR entries have been added. Call add_pr_entry once per PR you want in the recap before complete_recap.",
    );
  }

  const sourcePrIds = entries.map((e) => e.prId);

  // Best-effort walkthrough provenance: any walkthrough attached to the
  // entry PRs in the source bundle counts as "incorporated". Audit only —
  // not used for correctness.
  const allBundlePrs = [...ctx.sourceBundle.prs, ...ctx.sourceBundle.openPrs];
  const sourceWalkthroughIds = allBundlePrs
    .filter((p) => sourcePrIds.includes(p.id) && p.walkthrough)
    .map((p) => p.walkthrough!.id);

  ctx.db
    .update(projectRecaps)
    .set({
      summaryStats: JSON.stringify(ctx.sourceBundle.stats),
      sourcePrIds: JSON.stringify(sourcePrIds),
      sourceWalkthroughIds: JSON.stringify(sourceWalkthroughIds),
    })
    .where(eq(projectRecaps.id, ctx.recapId))
    .run();

  ctx.emit({ type: "phase", data: { phase: "finalizing", message: "Finalizing recap…" } });

  // Notify the orchestrator that the validation gate passed. The actual
  // status transition is performed by the orchestrator, not here — agent
  // never writes status (CLAUDE.md invariant #11).
  ctx.onCompleted();
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

  if (pr.diffDigest) {
    return ok(
      JSON.stringify({
        pr_id: input.pr_id,
        digest: pr.diffDigest,
        instructions:
          "Use this compact pre-ingested digest instead of asking for raw diff text. Do not call get_pr_diff again for this PR.",
      }),
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
