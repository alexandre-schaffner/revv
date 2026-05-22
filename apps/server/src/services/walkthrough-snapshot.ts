// ─── Walkthrough snapshot exporter ──────────────────────────────────────────
//
// Pure (DB-only) translation between an on-disk `walkthroughs`-row family
// and a `WalkthroughSnapshotV1`. Used by:
//
//   • RemoteWalkthroughCache.push — exports the row before gzip+upload.
//   • Tests — round-trips a generated walkthrough through
//     export → JSON → import to assert byte-for-byte equality.
//
// Excluded from the snapshot (local-only):
//   • walkthroughs.id, reviewSessionId, pullRequestId
//   • opencodeSessionId, resumeAttempts, lastEditedAt, lastEditedBy
//   • per-row ids on blocks/issues/ratings (regenerated on import)
//   • walkthrough_issues.submittedAt != null  (per-account GitHub state)
//
// Block linkage: `issue.blockIds` and `rating.blockIds` reference local
// block ids that don't survive a transport. The exporter converts each
// reference to an ordinal index into the exported `blocks[]` array.

import type {
  Confidence,
  GeneratedBy,
  GenerationProviderConfig,
  RatingAxis,
  RatingCitation,
  RiskLevel,
  Verdict,
  WalkthroughBlock,
  WalkthroughSnapshotBlock,
  WalkthroughSnapshotIssue,
  WalkthroughSnapshotRating,
  WalkthroughSnapshotSemanticStep,
  WalkthroughSnapshotV1,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { CACHE_SCHEMA_VERSION } from "@revv/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index";
import { walkthroughBlocks } from "../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../db/schema/walkthroughs";

export class ExportError extends Error {
  readonly _tag = "ExportError" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

interface ExportParams {
  walkthroughId: string;
  repoFullName: string;
}

function parseJsonArray<T>(s: string | null | undefined, guard: (v: unknown) => v is T): T[] {
  if (!s) return [];
  try {
    const parsed: unknown = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(guard);
  } catch {
    return [];
  }
}

const isString = (v: unknown): v is string => typeof v === "string";
const isCitation = (v: unknown): v is RatingCitation =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { filePath?: unknown }).filePath === "string" &&
  typeof (v as { startLine?: unknown }).startLine === "number" &&
  typeof (v as { endLine?: unknown }).endLine === "number";

function parseTokenUsage(raw: string | null): WalkthroughTokenUsage {
  if (!raw)
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
    }
    const u = parsed as Record<string, unknown>;
    return {
      inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : 0,
      outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : 0,
      cacheReadInputTokens: typeof u.cacheReadInputTokens === "number" ? u.cacheReadInputTokens : 0,
      cacheCreationInputTokens:
        typeof u.cacheCreationInputTokens === "number" ? u.cacheCreationInputTokens : 0,
    };
  } catch {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
  }
}

function parseProviderConfig(raw: string | null, modelUsed: string): GenerationProviderConfig {
  if (!raw) {
    return {
      provider: "claude-agent-sdk",
      model: modelUsed,
      thinkingEffort: null,
      contextWindow: null,
      maxTurns: 60,
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {
        provider: "claude-agent-sdk",
        model: modelUsed,
        thinkingEffort: null,
        contextWindow: null,
        maxTurns: 60,
      };
    }
    const c = parsed as Record<string, unknown>;
    const provider: GenerationProviderConfig["provider"] =
      c.provider === "opencode" ? "opencode" : "claude-agent-sdk";
    return {
      provider,
      model: typeof c.model === "string" ? c.model : modelUsed,
      thinkingEffort: typeof c.thinkingEffort === "string" ? c.thinkingEffort : null,
      contextWindow: typeof c.contextWindow === "string" ? c.contextWindow : null,
      maxTurns: typeof c.maxTurns === "number" ? c.maxTurns : 60,
    };
  } catch {
    return {
      provider: "claude-agent-sdk",
      model: modelUsed,
      thinkingEffort: null,
      contextWindow: null,
      maxTurns: 60,
    };
  }
}

/**
 * Build a `WalkthroughSnapshotV1` from a completed walkthrough row.
 *
 * Pre-conditions checked by the caller (`RemoteWalkthroughCache.push`):
 *   • `status='complete'` (avoids exporting half-generated rows)
 *   • `lastCompletedPhase='D'`
 *   • summary non-empty, sentiment non-empty
 *   • ≥1 diff block, all 9 axes rated
 *
 * Synchronous Drizzle reads — wrap in `Effect.try` at the call site if
 * you need an Effect-returning wrapper.
 */
export function exportWalkthroughSnapshot(db: Db, params: ExportParams): WalkthroughSnapshotV1 {
  const row = db.select().from(walkthroughs).where(eq(walkthroughs.id, params.walkthroughId)).get();
  if (!row) {
    throw new ExportError(`walkthrough ${params.walkthroughId} not found`);
  }

  const semanticRows = db
    .select()
    .from(walkthroughSemanticSteps)
    .where(eq(walkthroughSemanticSteps.walkthroughId, params.walkthroughId))
    .all();

  const blockRows = db
    .select()
    .from(walkthroughBlocks)
    .where(eq(walkthroughBlocks.walkthroughId, params.walkthroughId))
    .all();

  // Drop issues already pushed to GitHub — submission state is per-account
  // and must not leak across the cache.
  const issueRows = db
    .select()
    .from(walkthroughIssues)
    .where(
      and(
        eq(walkthroughIssues.walkthroughId, params.walkthroughId),
        isNull(walkthroughIssues.submittedAt),
      ),
    )
    .all();

  const ratingRows = db
    .select()
    .from(walkthroughRatings)
    .where(eq(walkthroughRatings.walkthroughId, params.walkthroughId))
    .all();

  // Sort blocks deterministically by (semanticStepIndex, stepIndex). The
  // resulting ordinal index is what `issue.blockIndexes` / `rating.blockIndexes`
  // point at on the importer side.
  const sortedBlocks = [...blockRows].sort(
    (a, b) => a.semanticStepIndex - b.semanticStepIndex || a.stepIndex - b.stepIndex,
  );

  // Map source block id → snapshot ordinal index.
  const blockIdToIndex = new Map<string, number>();
  sortedBlocks.forEach((b, idx) => {
    blockIdToIndex.set(b.id, idx);
  });

  const blocks: WalkthroughSnapshotBlock[] = sortedBlocks.map((b) => {
    const data = JSON.parse(b.data) as WalkthroughBlock;
    const phase: "diff_analysis" = "diff_analysis";
    const type = b.type as WalkthroughSnapshotBlock["type"];
    return {
      phase,
      semanticStepIndex: b.semanticStepIndex,
      stepIndex: b.stepIndex,
      type,
      data,
    };
  });

  const semanticSteps: WalkthroughSnapshotSemanticStep[] = [...semanticRows]
    .sort((a, b) => a.semanticStepIndex - b.semanticStepIndex)
    .map((s) => ({
      index: s.semanticStepIndex,
      title: s.title,
      summary: s.summary ?? null,
    }));

  const issues: WalkthroughSnapshotIssue[] = [...issueRows]
    .sort((a, b) => a.order - b.order)
    .map((i) => {
      const sourceIds = parseJsonArray(i.blockIds, isString);
      const blockIndexes = sourceIds
        .map((id) => blockIdToIndex.get(id))
        .filter((idx): idx is number => typeof idx === "number");
      return {
        order: i.order,
        severity: i.severity as WalkthroughSnapshotIssue["severity"],
        title: i.title,
        description: i.description,
        filePath: i.filePath ?? null,
        startLine: i.startLine ?? null,
        endLine: i.endLine ?? null,
        blockIndexes,
      };
    });

  const ratings: WalkthroughSnapshotRating[] = [...ratingRows]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => {
      const sourceIds = parseJsonArray(r.blockIds, isString);
      const blockIndexes = sourceIds
        .map((id) => blockIdToIndex.get(id))
        .filter((idx): idx is number => typeof idx === "number");
      return {
        axis: r.axis as RatingAxis,
        verdict: r.verdict as Verdict,
        confidence: r.confidence as Confidence,
        rationale: r.rationale,
        details: r.details,
        citations: parseJsonArray(r.citations, isCitation),
        blockIndexes,
      };
    });

  const providerConfig = parseProviderConfig(row.providerConfig, row.modelUsed);

  const generatedBy: GeneratedBy = {
    githubUserId: row.generatedByGithubUserId ?? 0,
    githubLogin: row.generatedByGithubLogin ?? "",
    displayName: row.generatedByDisplayName ?? null,
    avatarUrl: row.generatedByAvatarUrl ?? null,
  };

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    repoFullName: params.repoFullName,
    prHeadSha: row.prHeadSha,
    generatedBy,
    providerConfig,
    modelUsed: row.modelUsed,
    tokenUsage: parseTokenUsage(row.tokenUsage),
    summary: row.summary,
    riskLevel: row.riskLevel as RiskLevel,
    sentiment: row.sentiment ?? null,
    semanticSteps,
    blocks,
    issues,
    ratings,
    generatedAt: row.generatedAt,
  };
}

/**
 * Validate that a candidate snapshot satisfies every phase-output
 * contract. Used by the importer as a pre-commit gate (mirrors
 * `complete_walkthrough` from the MCP tool surface — same checks).
 *
 * Pass `expected` to bind the payload identity to the cache key: the
 * snapshot's `repoFullName` and `prHeadSha` must match the key the
 * caller used to fetch it, preventing a valid object at one key from
 * being accepted at a different key.
 */
export function validateSnapshot(
  s: WalkthroughSnapshotV1,
  expected?: { repoFullName: string; prHeadSha: string },
): { ok: true } | { ok: false; reason: string } {
  if (s.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schemaVersion=${s.schemaVersion}, expected ${CACHE_SCHEMA_VERSION}`,
    };
  }
  if (expected !== undefined) {
    if (s.repoFullName !== expected.repoFullName) {
      return {
        ok: false,
        reason: `repoFullName mismatch: payload=${s.repoFullName} expected=${expected.repoFullName}`,
      };
    }
    if (s.prHeadSha !== expected.prHeadSha) {
      return {
        ok: false,
        reason: `prHeadSha mismatch: payload=${s.prHeadSha} expected=${expected.prHeadSha}`,
      };
    }
  }
  if (!s.summary.trim()) return { ok: false, reason: "summary empty" };
  if (!s.sentiment?.trim()) return { ok: false, reason: "sentiment empty" };
  if (s.blocks.length === 0) return { ok: false, reason: "no diff blocks" };
  if (s.ratings.length !== 9) {
    return { ok: false, reason: `ratings.length=${s.ratings.length}, expected 9` };
  }
  const axes = new Set(s.ratings.map((r) => r.axis));
  const required: RatingAxis[] = [
    "correctness",
    "scope",
    "tests",
    "clarity",
    "safety",
    "consistency",
    "api_changes",
    "performance",
    "description",
  ];
  for (const a of required) {
    if (!axes.has(a)) return { ok: false, reason: `axis '${a}' missing` };
  }
  return { ok: true };
}
