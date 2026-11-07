// The restack-carry rule: when a stacked layer's head moves by a pure restack
// (its own changes byte-identical to a finished review's), the new head's row
// takes that review over instead of running an agent (CLAUDE.md invariant 7).
// The orchestrator's launch decides with it, and the stack overlay labels a
// layer `restacked` with it, so the label always says what a launch will do.

import { createHash } from "node:crypto";
import type { WalkthroughGenerationMode, WalkthroughMode } from "@revv/shared";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../../db";
import { type DiffFingerprint, walkthroughs } from "../../db/schema/walkthroughs";
import { finishedReview } from "./content";

interface FingerprintFile {
  readonly filename: string;
  readonly status: string;
  readonly patch: string | null;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Each file's change, hashed: two diffs agree on a file only when its hunks are byte-identical. */
export function fingerprintFiles(files: readonly FingerprintFile[]): DiffFingerprint {
  const out: Record<string, string> = {};
  for (const file of files) {
    // GitHub sends no patch for binaries and very large files: those can't be
    // compared, so they hash to a value no other fingerprint shares.
    out[file.filename] =
      file.patch === null ? `blob:${file.status}` : hash(`${file.status}\0${file.patch}`);
  }
  return out;
}

/** Files whose change differs between two fingerprints; a file without a patch always does. */
export function changedFiles(before: DiffFingerprint, after: DiffFingerprint): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => {
      const a = before[name];
      const b = after[name];
      return a === undefined || b === undefined || a !== b || a.startsWith("blob:");
    })
    .sort();
}

/** The finished review a restack of the PR to a new head could carry over. */
export interface RestackSource {
  readonly id: string;
  readonly generationMode: WalkthroughGenerationMode;
  readonly diffFingerprint: DiffFingerprint;
}

/**
 * The PR's latest finished `mode` review of another head, or null while a
 * review of `headSha` stands (it is the one to read or resume) or when that
 * latest review has no fingerprint to compare.
 */
export function restackSourceOf(
  db: Db,
  prId: string,
  headSha: string,
  mode: WalkthroughMode,
): RestackSource | null {
  const live = db
    .select({ id: walkthroughs.id })
    .from(walkthroughs)
    .where(
      and(
        eq(walkthroughs.pullRequestId, prId),
        eq(walkthroughs.prHeadSha, headSha),
        eq(walkthroughs.mode, mode),
        ne(walkthroughs.status, "superseded"),
      ),
    )
    .get();
  if (live) return null;
  const row = db
    .select({
      id: walkthroughs.id,
      generationMode: walkthroughs.generationMode,
      diffFingerprint: walkthroughs.diffFingerprint,
    })
    .from(walkthroughs)
    .where(
      and(
        eq(walkthroughs.pullRequestId, prId),
        eq(walkthroughs.mode, mode),
        ne(walkthroughs.prHeadSha, headSha),
        finishedReview(),
      ),
    )
    .orderBy(desc(walkthroughs.generatedAt))
    .get();
  if (!row?.diffFingerprint) return null;
  return {
    id: row.id,
    generationMode: row.generationMode === "incremental" ? "incremental" : "full",
    diffFingerprint: row.diffFingerprint,
  };
}

export interface RestackCarry {
  readonly fromWalkthroughId: string;
  readonly generationMode: WalkthroughGenerationMode;
}

/**
 * Whether a run asked for in `requestedMode` at a head whose diff is
 * `fingerprint` takes `source` over: only when the layer's own changes are
 * byte-identical, and the source reviewed at least as much (a full review
 * stands for an incremental one, not the reverse).
 */
export function restackCarry(
  source: RestackSource | null,
  requestedMode: WalkthroughGenerationMode,
  fingerprint: DiffFingerprint,
): RestackCarry | null {
  if (source === null) return null;
  if (source.generationMode !== "full" && source.generationMode !== requestedMode) return null;
  if (changedFiles(source.diffFingerprint, fingerprint).length > 0) return null;
  return { fromWalkthroughId: source.id, generationMode: source.generationMode };
}
