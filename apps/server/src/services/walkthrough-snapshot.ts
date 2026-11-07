// Translates a walkthrough row family into a `WalkthroughSnapshotV2`, for the
// team-cache push and the restack carry. Local-only state stays behind (see
// `walkthrough-cache-format.ts`); block links travel as ordinal indexes into
// the exported `blocks[]`, since block ids are per-walkthrough.

import type { RiskLevel } from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { walkthroughs } from "../db/schema/walkthroughs";
import {
  decodeBlock,
  decodeCitations,
  decodeProviderConfig,
  decodeStringArray,
  decodeTokenUsage,
  loadContentRows,
  normalizeProviderConfig,
} from "./walkthrough/content";
import {
  CACHE_SCHEMA_VERSION,
  type GeneratedBy,
  type WalkthroughSnapshotBlock,
  type WalkthroughSnapshotIssue,
  type WalkthroughSnapshotRating,
  type WalkthroughSnapshotV2,
} from "./walkthrough-cache-format";

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

/**
 * Pre-conditions checked by the caller:
 *   • `status='complete'` (`RemoteWalkthroughCache.push`), or `'superseded'`
 *     with `completedAt` set (a restack carry, `findRestackSource`): never a
 *     half-generated row
 *   • `lastCompletedPhase='D'`
 *   • summary non-empty, sentiment non-empty
 *   • ≥1 diff block, all 9 axes rated
 *
 * Synchronous, and throws `ExportError`: wrap it in `Effect.try`.
 */
export function exportWalkthroughSnapshot(db: Db, params: ExportParams): WalkthroughSnapshotV2 {
  const row = db.select().from(walkthroughs).where(eq(walkthroughs.id, params.walkthroughId)).get();
  if (!row) {
    throw new ExportError(`walkthrough ${params.walkthroughId} not found`);
  }
  const content = loadContentRows(db, params.walkthroughId);

  const blocks: WalkthroughSnapshotBlock[] = [];
  const blockIndex = new Map<string, number>();
  for (const b of content.blocks) {
    const data = decodeBlock(b);
    if (!data) continue;
    blockIndex.set(b.id, blocks.length);
    blocks.push({
      phase: "diff_analysis",
      semanticStepIndex: b.semanticStepIndex,
      stepIndex: b.stepIndex,
      type: b.type as WalkthroughSnapshotBlock["type"],
      data,
    });
  }
  const blockIndexes = (raw: string): number[] =>
    decodeStringArray(raw).flatMap((id) => {
      const index = blockIndex.get(id);
      return index === undefined ? [] : [index];
    });

  // Submission to GitHub is per-account state and must not leak across the cache.
  const issues: WalkthroughSnapshotIssue[] = content.issues
    .filter((i) => i.submittedAt === null)
    .map((i) => ({
      order: i.order,
      severity: i.severity as WalkthroughSnapshotIssue["severity"],
      title: i.title,
      description: i.description,
      filePath: i.filePath ?? null,
      startLine: i.startLine ?? null,
      endLine: i.endLine ?? null,
      blockIndexes: blockIndexes(i.blockIds),
    }));

  const ratings: WalkthroughSnapshotRating[] = content.ratings.map((r) => ({
    axis: r.axis as WalkthroughSnapshotRating["axis"],
    verdict: r.verdict as WalkthroughSnapshotRating["verdict"],
    confidence: r.confidence as WalkthroughSnapshotRating["confidence"],
    rationale: r.rationale,
    details: r.details,
    citations: decodeCitations(r.citations),
    blockIndexes: blockIndexes(r.blockIds),
  }));

  const generatedBy: GeneratedBy = {
    githubUserId: row.generatedByGithubUserId ?? 0,
    githubLogin: row.generatedByGithubLogin ?? "",
    displayName: row.generatedByDisplayName ?? null,
    avatarContent: row.generatedByAvatarContent ?? null,
  };

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    repoFullName: params.repoFullName,
    prHeadSha: row.prHeadSha,
    generatedBy,
    providerConfig:
      decodeProviderConfig(row.providerConfig, row.modelUsed) ??
      normalizeProviderConfig({}, row.modelUsed),
    modelUsed: row.modelUsed,
    tokenUsage: decodeTokenUsage(row.tokenUsage),
    summary: row.summary,
    riskLevel: row.riskLevel as RiskLevel,
    sentiment: row.sentiment ?? null,
    semanticSteps: content.semanticSteps.map((s) => ({
      index: s.semanticStepIndex,
      title: s.title,
      summary: s.summary ?? null,
    })),
    blocks,
    issues,
    ratings,
    generatedAt: row.generatedAt,
  };
}

/**
 * The phase-output contract a snapshot must meet, mirroring the
 * `complete_walkthrough` gate. The importer checks it before committing.
 */
export function validateSnapshot(
  s: WalkthroughSnapshotV2,
): { ok: true } | { ok: false; reason: string } {
  if (s.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schemaVersion=${s.schemaVersion}, expected ${CACHE_SCHEMA_VERSION}`,
    };
  }
  if (!s.summary.trim()) return { ok: false, reason: "summary empty" };
  if (!s.sentiment?.trim()) return { ok: false, reason: "sentiment empty" };
  if (s.blocks.length === 0) return { ok: false, reason: "no diff blocks" };
  if (s.ratings.length !== RATING_AXES.length) {
    return {
      ok: false,
      reason: `ratings.length=${s.ratings.length}, expected ${RATING_AXES.length}`,
    };
  }
  const axes = new Set(s.ratings.map((r) => r.axis));
  for (const a of RATING_AXES) {
    if (!axes.has(a)) return { ok: false, reason: `axis '${a}' missing` };
  }
  return { ok: true };
}
