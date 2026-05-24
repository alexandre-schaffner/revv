// ─── Remote walkthrough cache (GCS-backed) ──────────────────────────────────
//
// Wire format for the team-shared walkthrough cache. The local server
// gzip-encodes a `WalkthroughSnapshotV1` and uploads it to:
//
//   gs://<bucket>/<owner>/<repo>/<headSha>.json.gz
//
// On a teammate's machine, the same key is probed before kicking off the
// agent fiber. A hit imports the snapshot in a single transaction and
// flips the row to `status='complete'` — no LLM calls, no token spend.
//
// Schema versioning: any payload-shape change MUST bump
// `CACHE_SCHEMA_VERSION` (and a new `WalkthroughSnapshotV<N>` type lands
// alongside). The importer rejects mismatched versions as
// `CacheCorrupt` and falls back to local generation.

import type {
  Confidence,
  RatingAxis,
  RatingCitation,
  RiskLevel,
  Verdict,
  WalkthroughBlock,
  WalkthroughTokenUsage,
} from "./walkthrough";

/** Bump this when the snapshot shape changes. Importers reject mismatches. */
export const CACHE_SCHEMA_VERSION = 1 as const;

/**
 * Captured atomically at job start so a settings change mid-run doesn't
 * corrupt the recorded config. Travels with the snapshot to the bucket
 * and back, so cache-hit UI can render "claude-opus-4-7 • thinking: high
 * • 1m context" from the original run rather than the live settings.
 */
export interface GenerationProviderConfig {
  provider: "claude-agent-sdk" | "opencode";
  model: string;
  /** "ultrathink" | "max" | "extra-high" | "high" | "medium" | "low" | null. */
  thinkingEffort: string | null;
  /** `"200k"` | `"1m"` | null (null = SDK default). */
  contextWindow: string | null;
  maxTurns: number;
}

/** GitHub identity of the teammate that triggered the original generation. */
export interface GeneratedBy {
  /** Stable numeric GitHub user id — survives login renames. */
  githubUserId: number;
  /** GitHub login, e.g. `"alice"`. */
  githubLogin: string;
  /** Optional GitHub display name. */
  displayName: string | null;
  /** Avatar data URL for the cache-hit badge. */
  avatarContent: string | null;
}

/**
 * Snapshot block — strip transient ids, keep the typed payload. Local
 * `id` and `walkthroughId` are regenerated on import; the `blockIndex`
 * ordinal (set at export time) is the durable handle used by
 * `issue.blockIndexes` and `rating.blockIndexes`.
 */
export interface WalkthroughSnapshotBlock {
  /** Always `"diff_analysis"` in v1 — Phase A/C blocks live on the row. */
  phase: "diff_analysis";
  semanticStepIndex: number;
  stepIndex: number;
  /** Block type — discriminates the `data` payload. */
  type: "diff" | "code" | "markdown";
  /** Typed payload — same shape as the on-row JSON. */
  data: WalkthroughBlock;
}

export interface WalkthroughSnapshotIssue {
  order: number;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  /**
   * Indices into the `blocks` array (NOT block ids). Survives ID
   * regeneration on import. Empty list = unlinked issue.
   */
  blockIndexes: number[];
}

export interface WalkthroughSnapshotRating {
  axis: RatingAxis;
  verdict: Verdict;
  confidence: Confidence;
  rationale: string;
  details: string;
  citations: RatingCitation[];
  /** Ordinal indices into `blocks[]` — survives ID regeneration. */
  blockIndexes: number[];
}

export interface WalkthroughSnapshotSemanticStep {
  index: number;
  title: string;
  summary: string | null;
}

/**
 * Top-level snapshot envelope. Gzipped + uploaded to:
 *   gs://<bucket>/<owner>/<repo>/<headSha>.json.gz
 *
 * Excluded from the snapshot (local-only):
 *   • walkthrough id, review session id, pull request id
 *   • opencodeSessionId, resumeAttempts
 *   • lastEditedAt, lastEditedBy
 *   • issues where `submittedAt != null` (per-account GitHub state)
 *   • per-row ids on blocks/issues/ratings (regenerated on import)
 */
export interface WalkthroughSnapshotV1 {
  schemaVersion: 1;
  /** `"owner/repo"` — pairs with `prHeadSha` to locate the bucket object. */
  repoFullName: string;
  prHeadSha: string;
  /** GitHub identity of the original generator. */
  generatedBy: GeneratedBy;
  /** AI provider config captured at job start. */
  providerConfig: GenerationProviderConfig;
  /**
   * Retained for back-compat with existing `walkthroughs.modelUsed`
   * column. Equal to `providerConfig.model`. Importers should write
   * this verbatim to the row's `modelUsed` field.
   */
  modelUsed: string;
  tokenUsage: WalkthroughTokenUsage;
  summary: string;
  riskLevel: RiskLevel;
  sentiment: string | null;
  semanticSteps: WalkthroughSnapshotSemanticStep[];
  blocks: WalkthroughSnapshotBlock[];
  ratings: WalkthroughSnapshotRating[];
  issues: WalkthroughSnapshotIssue[];
  /** ISO 8601 timestamp from the original generator's machine. */
  generatedAt: string;
}

/**
 * Build the canonical object key for the bucket. Mirrors GitHub's
 * natural addressing — same key on every teammate's machine.
 */
export function cacheObjectKey(repoFullName: string, prHeadSha: string): string {
  return `${repoFullName}/${prHeadSha}.json.gz`;
}

/**
 * GCS custom-metadata keys set on every upload. Importers read these
 * back to verify integrity before parsing the body.
 */
export const CACHE_METADATA_KEYS = {
  /** Stringified `CACHE_SCHEMA_VERSION`. */
  schemaVersion: "schemaVersion",
  /** The exact model id that produced the snapshot. */
  modelUsed: "modelUsed",
  /** Local user id of the uploader. Advisory only — IAM is the auth. */
  uploadedByUserId: "uploadedByUserId",
  /** Hex SHA-256 of the gzipped body. Crosschecked on download. */
  contentSha256: "contentSha256",
  /** SSHSIG armored block produced by the uploader's private key. */
  signature: "signature",
  /** GitHub host of the signing account, e.g. `github.com`. */
  signerHost: "signerHost",
  /** GitHub login of the signer, e.g. `alice`. */
  signerLogin: "signerLogin",
  /** Stable numeric GitHub user id of the signer. Advisory. */
  signerGithubUserId: "signerGithubUserId",
  /** SSHSIG namespace — `revv-cache@<signerHost>`. */
  signatureNamespace: "signatureNamespace",
} as const;

/**
 * Signing mode for the team cache. Controls whether blobs must be signed
 * (`'strict'`), accepted with a warning when signature is missing/invalid
 * (`'permissive'`), or have signing bypassed entirely (`'off'`).
 *
 * Default is `'strict'` — new installs get protection out of the box.
 */
export type CacheSigningMode = "off" | "permissive" | "strict";

/**
 * Build the canonical signing message that is signed on push and
 * verified on fetch. Binds the signature to the object's identity
 * (repo + head SHA + content hash) without streaming MB through a child
 * process — `contentSha256` already covers the body bytes.
 */
export function cacheSigningMessage(
  repoFullName: string,
  prHeadSha: string,
  contentSha256: string,
): string {
  return `revv-cache:v1\n${repoFullName}\n${prHeadSha}\n${contentSha256}`;
}
