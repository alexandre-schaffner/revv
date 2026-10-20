// ─── stack-brief-tools/handlers ──────────────────────────────────────────────
//
// Shared handlers behind `/mcp/stack-brief`. Every write is one synchronous
// transaction keyed on a deterministic identity, so a replay is a no-op
// (CLAUDE.md invariant 3) and an out-of-order call fails with an error the
// agent can act on, before the row is touched (invariant 5).

import { and, desc, eq, inArray } from "drizzle-orm";
import { prDiffFiles } from "../../../db/schema/pr-diff-files";
import { stackBriefLayers, stackBriefs } from "../../../db/schema/stack-briefs";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import { takeawayOf } from "../../../services/stacks/overlay";
import {
  ARC_MAX_CHARS,
  BUILDS_ON_MAX,
  CHAPTER_MAX_CHARS,
  type CompleteStackBriefInput,
  type GetStackBriefStateInput,
  type GetStackLayersInput,
  LAYER_LINE_MAX_CHARS,
  parseStackBriefSnapshot,
  type SetArcInput,
  type SetLayerRoleInput,
  type StackBriefSnapshot,
  type StackBriefToolContext,
  type StackBriefToolHandler,
  type StackBriefToolResult,
  USES_MAX_CHARS,
} from "./spec";

/** File paths listed per layer: enough to see its shape, bounded for big layers. */
const LAYER_FILES_MAX = 80;
const ISSUE_TITLES_MAX = 6;
const SENTIMENT_EXCERPT_CHARS = 400;

function ok(text: string): StackBriefToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string): StackBriefToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

type Db = StackBriefToolContext["db"];

interface LoadedBrief {
  readonly status: string;
  readonly phase: string;
  readonly arc: string;
  readonly reviewOrder: string;
  readonly snapshot: StackBriefSnapshot;
}

/** The brief row, or the tool error to answer with instead. */
function loadBrief(db: Db, briefId: string, action: string): LoadedBrief | StackBriefToolResult {
  const row = db
    .select({
      status: stackBriefs.status,
      phase: stackBriefs.lastCompletedPhase,
      arc: stackBriefs.arc,
      reviewOrder: stackBriefs.reviewOrder,
      snapshot: stackBriefs.stackSnapshot,
    })
    .from(stackBriefs)
    .where(eq(stackBriefs.id, briefId))
    .get();
  if (!row) return err(`Stack brief ${briefId} not found. Aborting ${action}.`);
  const snapshot = parseStackBriefSnapshot(row.snapshot);
  if (!snapshot) return err(`Stack brief ${briefId} has no readable snapshot. Aborting ${action}.`);
  return { ...row, snapshot };
}

function isToolResult(v: LoadedBrief | StackBriefToolResult): v is StackBriefToolResult {
  return "content" in v;
}

/** Writes need a brief that is still generating: a superseded one is somebody else's. */
function loadGenerating(
  db: Db,
  briefId: string,
  action: string,
): LoadedBrief | StackBriefToolResult {
  const brief = loadBrief(db, briefId, action);
  if (isToolResult(brief)) return brief;
  if (brief.status !== "generating") {
    return err(`Stack brief is no longer generating (status=${brief.status}). Aborting ${action}.`);
  }
  return brief;
}

function writtenLayers(db: Db, briefId: string) {
  return db
    .select({
      position: stackBriefLayers.position,
      prNumber: stackBriefLayers.prNumber,
      role: stackBriefLayers.role,
      reviewFocus: stackBriefLayers.reviewFocus,
      chapter: stackBriefLayers.chapter,
      buildsOn: stackBriefLayers.buildsOn,
    })
    .from(stackBriefLayers)
    .where(eq(stackBriefLayers.briefId, briefId))
    .orderBy(stackBriefLayers.position)
    .all()
    .map(({ buildsOn, ...row }) => ({ ...row, buildsOn: JSON.parse(buildsOn) as BuildsOnLink[] }));
}

/**
 * Snapshot layers without a role yet, as `#N (position P)` labels. A row from
 * before chapters existed counts as missing, so a resumed run rewrites it.
 */
function missingLayers(db: Db, briefId: string, snapshot: StackBriefSnapshot): string[] {
  const written = new Set(
    writtenLayers(db, briefId)
      .filter((l) => l.chapter !== null)
      .map((l) => l.position),
  );
  return snapshot.layers
    .filter((l) => !written.has(l.position))
    .map((l) => `#${l.number} (position ${l.position})`);
}

function parseOrder(json: string): number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/** One line of prose: trimmed, single-spaced, or the reason it isn't. */
function oneLine(
  raw: string,
  field: string,
  max = LAYER_LINE_MAX_CHARS,
): { value: string } | { error: string } {
  if (/[\r\n]/.test(raw.trim())) {
    return { error: `${field} must be one line; it contains a line break.` };
  }
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length === 0) return { error: `${field} is empty.` };
  if (value.length > max) {
    return {
      error: `${field} is ${value.length} characters; the limit is ${max}. Cut it to one sharp line.`,
    };
  }
  return { value };
}

interface BuildsOnLink {
  readonly number: number;
  readonly uses: string;
}

/**
 * The links a layer declares, checked against the stack: each a layer below
 * it (open or merged), once, at most {@link BUILDS_ON_MAX}. Order is kept so
 * a replay of the same call stores the same JSON.
 */
function checkBuildsOn(
  links: ReadonlyArray<{ number: number; uses: string }>,
  layer: { position: number; number: number },
  snapshot: StackBriefSnapshot,
): { value: BuildsOnLink[] } | { error: string } {
  if (links.length > BUILDS_ON_MAX) {
    return {
      error: `builds_on has ${links.length} layers; name at most ${BUILDS_ON_MAX}, the ones this layer leans on hardest.`,
    };
  }
  const below = new Set([
    ...snapshot.layers.filter((l) => l.position < layer.position).map((l) => l.number),
    ...snapshot.merged.map((m) => m.number),
  ]);
  const seen = new Set<number>();
  const value: BuildsOnLink[] = [];
  for (const link of links) {
    if (!below.has(link.number)) {
      return {
        error: `builds_on names #${link.number}, which isn't below #${layer.number}. Lower layers: ${[...below].map((n) => `#${n}`).join(", ") || "none"}.`,
      };
    }
    if (seen.has(link.number)) return { error: `builds_on names #${link.number} twice.` };
    seen.add(link.number);
    const uses = oneLine(link.uses, `builds_on #${link.number} uses`, USES_MAX_CHARS);
    if ("error" in uses) return uses;
    value.push({ number: link.number, uses: uses.value });
  }
  return { value };
}

// ── Read tools ───────────────────────────────────────────────────────────────

export const getStackBriefStateHandler: StackBriefToolHandler<GetStackBriefStateInput> = async (
  ctx,
) => {
  const brief = loadBrief(ctx.db, ctx.briefId, "get_stack_brief_state");
  if (isToolResult(brief)) return brief;
  const layers = writtenLayers(ctx.db, ctx.briefId);
  const resuming = layers.length > 0 || brief.arc.trim().length > 0;
  return ok(
    JSON.stringify({
      briefId: ctx.briefId,
      status: brief.status,
      phase: brief.phase,
      snapshot: {
        stackNumber: brief.snapshot.stackNumber,
        baseRefName: brief.snapshot.baseRefName,
        layers: brief.snapshot.layers.map(({ body: _body, ...layer }) => layer),
        merged: brief.snapshot.merged,
      },
      layersWritten: layers,
      arc: brief.arc || null,
      reviewOrder: parseOrder(brief.reviewOrder),
      instructions:
        "Call get_stack_layers next. Then set_layer_role once per layer in snapshot.layers, then set_arc, then complete_stack_brief." +
        (resuming
          ? " A prior run already wrote the layers in layersWritten (and the arc, if non-null): keep what is accurate, write only what is missing. Don't mention that you're resuming."
          : ""),
    }),
  );
};

export const getStackLayersHandler: StackBriefToolHandler<GetStackLayersInput> = async (ctx) => {
  const brief = loadBrief(ctx.db, ctx.briefId, "get_stack_layers");
  if (isToolResult(brief)) return brief;

  const prIds = brief.snapshot.layers.map((l) => l.prId).filter((id): id is string => id !== null);

  const filesByPr = new Map<string, string[]>();
  if (prIds.length > 0) {
    for (const f of ctx.db
      .select({ prId: prDiffFiles.prId, path: prDiffFiles.path })
      .from(prDiffFiles)
      .where(inArray(prDiffFiles.prId, prIds))
      .orderBy(prDiffFiles.path)
      .all()) {
      const list = filesByPr.get(f.prId) ?? [];
      list.push(f.path);
      filesByPr.set(f.prId, list);
    }
  }

  const reviews =
    prIds.length === 0
      ? []
      : ctx.db
          .select({
            id: walkthroughs.id,
            prId: walkthroughs.pullRequestId,
            status: walkthroughs.status,
            phase: walkthroughs.lastCompletedPhase,
            completedAt: walkthroughs.completedAt,
            prHeadSha: walkthroughs.prHeadSha,
            summary: walkthroughs.summary,
            sentiment: walkthroughs.sentiment,
            riskLevel: walkthroughs.riskLevel,
          })
          .from(walkthroughs)
          .where(inArray(walkthroughs.pullRequestId, prIds))
          .orderBy(desc(walkthroughs.generatedAt))
          .all()
          .filter((w) => w.phase === "D" && w.completedAt !== null && w.status !== "error");

  const layers = brief.snapshot.layers.map((layer) => {
    const files = layer.prId ? (filesByPr.get(layer.prId) ?? []) : [];
    const forPr = reviews.filter((w) => w.prId === layer.prId);
    // The review at this head when there is one, else the latest: an older
    // review still says what the layer is for.
    const review = forPr.find((w) => w.prHeadSha === layer.headSha) ?? forPr[0];
    let walkthrough = null;
    if (review) {
      const issues = ctx.db
        .select({ title: walkthroughIssues.title, severity: walkthroughIssues.severity })
        .from(walkthroughIssues)
        .where(
          and(
            eq(walkthroughIssues.walkthroughId, review.id),
            eq(walkthroughIssues.resolutionStatus, "open"),
          ),
        )
        .orderBy(walkthroughIssues.order)
        .all();
      const sentiment = review.sentiment?.trim() ?? "";
      walkthrough = {
        current: review.prHeadSha === layer.headSha,
        takeaway: takeawayOf(review.summary),
        sentimentExcerpt:
          sentiment.length > SENTIMENT_EXCERPT_CHARS
            ? `${sentiment.slice(0, SENTIMENT_EXCERPT_CHARS)}…`
            : sentiment || null,
        riskLevel: review.riskLevel,
        openIssues: issues.length,
        openIssueTitles: issues.slice(0, ISSUE_TITLES_MAX).map((i) => `[${i.severity}] ${i.title}`),
      };
    }
    return {
      position: layer.position,
      number: layer.number,
      title: layer.title,
      status: layer.status,
      tracked: layer.prId !== null,
      additions: layer.additions,
      deletions: layer.deletions,
      changedFiles: layer.changedFiles,
      bodyExcerpt: layer.body,
      files: files.slice(0, LAYER_FILES_MAX),
      filesTruncated: files.length > LAYER_FILES_MAX,
      walkthrough,
    };
  });

  return ok(
    JSON.stringify({
      baseRefName: brief.snapshot.baseRefName,
      layers,
      merged: brief.snapshot.merged,
      instructions:
        "Layers are bottom first: each one's diff is against the layer below. `walkthrough` is Revv's review of the layer (null when none exists); `current: false` means it read an older head. An empty `files` list means Revv hasn't fetched that layer's diff, not that it changes nothing. Describe only what this data shows.",
    }),
  );
};

// ── Phase L ──────────────────────────────────────────────────────────────────

export const setLayerRoleHandler: StackBriefToolHandler<SetLayerRoleInput> = async (ctx, input) => {
  const role = oneLine(input.role, "role");
  if ("error" in role) return err(`Error: ${role.error}`);
  const focus = oneLine(input.review_focus, "review_focus");
  if ("error" in focus) return err(`Error: ${focus.error}`);
  const chapter = oneLine(input.chapter, "chapter", CHAPTER_MAX_CHARS);
  if ("error" in chapter) return err(`Error: ${chapter.error}`);

  return ctx.db.transaction(() => {
    const brief = loadGenerating(ctx.db, ctx.briefId, "set_layer_role");
    if (isToolResult(brief)) return brief;
    const layer = brief.snapshot.layers.find((l) => l.position === input.position);
    if (!layer) {
      const valid = brief.snapshot.layers.map((l) => `${l.position} (#${l.number})`).join(", ");
      return err(
        `Error: no open layer at position ${input.position}. Valid positions: ${valid}. Merged layers take no role.`,
      );
    }

    const links = checkBuildsOn(input.builds_on, layer, brief.snapshot);
    if ("error" in links) return err(`Error: ${links.error}`);
    const buildsOn = JSON.stringify(links.value);

    const existing = ctx.db
      .select({
        role: stackBriefLayers.role,
        reviewFocus: stackBriefLayers.reviewFocus,
        chapter: stackBriefLayers.chapter,
        buildsOn: stackBriefLayers.buildsOn,
      })
      .from(stackBriefLayers)
      .where(
        and(
          eq(stackBriefLayers.briefId, ctx.briefId),
          eq(stackBriefLayers.position, layer.position),
        ),
      )
      .get();
    // A replay of the same line writes nothing, not even `updated_at`.
    if (
      !existing ||
      existing.role !== role.value ||
      existing.reviewFocus !== focus.value ||
      existing.chapter !== chapter.value ||
      existing.buildsOn !== buildsOn
    ) {
      const now = new Date().toISOString();
      ctx.db
        .insert(stackBriefLayers)
        .values({
          id: `${ctx.briefId}:${layer.position}`,
          briefId: ctx.briefId,
          position: layer.position,
          prNumber: layer.number,
          role: role.value,
          reviewFocus: focus.value,
          chapter: chapter.value,
          buildsOn,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [stackBriefLayers.briefId, stackBriefLayers.position],
          set: {
            role: role.value,
            reviewFocus: focus.value,
            chapter: chapter.value,
            buildsOn,
            updatedAt: now,
          },
        })
        .run();
    }

    const missing = missingLayers(ctx.db, ctx.briefId, brief.snapshot);
    if (missing.length === 0 && brief.phase === "none") {
      ctx.db
        .update(stackBriefs)
        .set({ lastCompletedPhase: "L" })
        .where(eq(stackBriefs.id, ctx.briefId))
        .run();
    }
    return ok(
      missing.length === 0
        ? `Role stored for #${layer.number}. Every layer has a role: call set_arc next.`
        : `Role stored for #${layer.number}. Still missing: ${missing.join(", ")}.`,
    );
  });
};

// ── Phase R ──────────────────────────────────────────────────────────────────

export const setArcHandler: StackBriefToolHandler<SetArcInput> = async (ctx, input) => {
  const arc = input.arc_markdown.trim();
  if (arc.length === 0) return err("Error: arc_markdown is empty.");
  if (arc.length > ARC_MAX_CHARS) {
    return err(
      `Error: arc_markdown is ${arc.length} characters; the limit is ${ARC_MAX_CHARS}. Two or three sentences.`,
    );
  }

  return ctx.db.transaction(() => {
    const brief = loadGenerating(ctx.db, ctx.briefId, "set_arc");
    if (isToolResult(brief)) return brief;
    const missing = missingLayers(ctx.db, ctx.briefId, brief.snapshot);
    if (missing.length > 0) {
      return err(
        `Error: set_arc needs every layer's role first. Call set_layer_role for: ${missing.join(", ")}.`,
      );
    }

    const expected = brief.snapshot.layers.map((l) => l.number);
    const given = input.review_order;
    const isPermutation =
      given.length === expected.length &&
      new Set(given).size === given.length &&
      given.every((n) => expected.includes(n));
    if (!isPermutation) {
      return err(
        `Error: review_order must list each open layer's PR number exactly once: [${expected.join(", ")}] in some order. Got [${given.join(", ")}].`,
      );
    }

    const reviewOrder = JSON.stringify(given);
    if (brief.phase === "R" && brief.arc === arc && brief.reviewOrder === reviewOrder) {
      return ok("Arc already stored. Call complete_stack_brief.");
    }
    ctx.db
      .update(stackBriefs)
      .set({ arc, reviewOrder, lastCompletedPhase: "R" })
      .where(eq(stackBriefs.id, ctx.briefId))
      .run();
    return ok("Arc stored. Call complete_stack_brief.");
  });
};

// ── Validation gate ──────────────────────────────────────────────────────────

/** Why the brief can't complete yet, or null when it can. */
function completionBlocker(db: Db, briefId: string): StackBriefToolResult | null {
  const brief = loadGenerating(db, briefId, "complete_stack_brief");
  if (isToolResult(brief)) return brief;
  const missing = missingLayers(db, briefId, brief.snapshot);
  if (missing.length > 0) {
    return err(`Error: layers without a role: ${missing.join(", ")}. Call set_layer_role first.`);
  }
  if (brief.phase !== "R" || brief.arc.trim().length === 0) {
    return err("Error: the arc isn't written. Call set_arc before complete_stack_brief.");
  }
  return null;
}

export const completeStackBriefHandler: StackBriefToolHandler<CompleteStackBriefInput> = async (
  ctx,
) => {
  const blocker = completionBlocker(ctx.db, ctx.briefId);
  if (blocker) return blocker;
  // The orchestrator transitions status; the agent never does (invariant 11).
  ctx.onCompleted();
  return ok("Stack brief complete. The orchestrator will finalize it. You may stop.");
};
