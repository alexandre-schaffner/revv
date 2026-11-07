// Wire format for the team-shared walkthrough cache. The local server
// gzip-encodes a `WalkthroughSnapshotV2` and uploads it to the key
// `cacheObjectKey` names:
//
//   gs://<bucket>/<owner>/<repo>/<headSha>.json.gz               (github.com)
//   gs://<bucket>/<githubHost>/<owner>/<repo>/<headSha>.json.gz  (Enterprise)
//
// On a teammate's machine, the same key is probed before kicking off the
// agent fiber. A hit imports the snapshot in a single transaction and
// flips the row to `status='complete'` — no LLM calls, no token spend.
//
// Schema versioning: any payload-shape change MUST bump
// `CACHE_SCHEMA_VERSION` (and a new `WalkthroughSnapshotV<N>` type lands
// alongside). A fetch treats a mismatched version as a miss, so the
// teammate falls back to local generation.

import {
  type AcpAgentId,
  type Confidence,
  isPublicGitHub,
  normalizeGithubHost,
  type RatingAxis,
  type RatingCitation,
  type RiskLevel,
  type Verdict,
  type WalkthroughBlock,
  type WalkthroughTokenUsage,
} from "@revv/shared";

export const CACHE_SCHEMA_VERSION = 2 as const;

/**
 * Captured at job start so a mid-run settings change doesn't alter it.
 * Travels with the snapshot, so the cache-hit UI shows the original run's
 * config rather than the live settings.
 */
export interface GenerationProviderConfig {
  /**
   * The agent that ran. Installs that predate the ACP-only transport wrote the
   * driver instead (`claude-agent-sdk | opencode | codex`) and still send it;
   * `decodeProviderConfig` maps those. No version of Revv branches on this
   * field — older readers store and re-export it as an opaque string — so an
   * agent id they don't know is safe to send them.
   */
  provider: AcpAgentId;
  model: string;
  /** A `ThinkingEffort` tier as a raw string, or null. */
  thinkingEffort: string | null;
  /** `"200k"` | `"1m"` | null (null = SDK default). */
  contextWindow: string | null;
  maxTurns: number;
}

/** GitHub identity of the teammate that triggered the original generation. */
export interface GeneratedBy {
  /** Stable numeric GitHub user id — survives login renames. */
  githubUserId: number;
  githubLogin: string;
  displayName: string | null;
  /** Avatar data URL for the cache-hit badge. */
  avatarContent: string | null;
}

/**
 * Snapshot block — strip local ids, keep the typed payload. The importer
 * derives the importing walkthrough's ids; the ordinal index into `blocks[]`
 * is the durable handle used by `issue.blockIndexes` and `rating.blockIndexes`.
 */
export interface WalkthroughSnapshotBlock {
  /**
   * Always `"diff_analysis"`: Phase A/C content lives on the row. Clients no
   * longer read it, but older importers write it to the block's row.
   */
  phase: "diff_analysis";
  semanticStepIndex: number;
  stepIndex: number;
  type: WalkthroughBlock["type"];
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
 * Top-level snapshot envelope. Gzipped + uploaded to `cacheObjectKey`.
 *
 * Excluded from the snapshot (local-only):
 *   • walkthrough id, review session id, pull request id
 *   • resumeAttempts
 *   • lastEditedAt, lastEditedBy
 *   • issues where `submittedAt != null` (per-account GitHub state)
 *   • per-row ids on blocks/issues/ratings (the importer derives its own)
 */
export interface WalkthroughSnapshotV2 {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  /** `"owner/repo"` — pairs with `prHeadSha` to locate the bucket object. */
  repoFullName: string;
  prHeadSha: string;
  generatedBy: GeneratedBy;
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

/** A repository as the team cache addresses it: owner/name on its GitHub host. */
export interface CacheRepo {
  readonly githubHost: string;
  readonly fullName: string;
}

/**
 * The object key a review of `repo` at `prHeadSha` is pushed to and read
 * from, the same on every teammate's machine. A github.com repo keeps the
 * key that names no host, so clients from before Enterprise repos had keys
 * of their own still share reviews with newer ones. An Enterprise repo's key
 * names its host: one more path segment, so it never meets a github.com key.
 */
export function cacheObjectKey(repo: CacheRepo, prHeadSha: string): string {
  const path = `${repo.fullName}/${prHeadSha}.json.gz`;
  return isPublicGitHub(repo.githubHost) ? path : `${normalizeGithubHost(repo.githubHost)}/${path}`;
}

/**
 * GCS custom-metadata keys set on every upload. Importers read these
 * back to verify integrity before parsing the body.
 */
export const CACHE_METADATA_KEYS = {
  /** Stringified `CACHE_SCHEMA_VERSION`. */
  schemaVersion: "schemaVersion",
  modelUsed: "modelUsed",
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
 * Build the canonical signing message that is signed on push and
 * verified on fetch. Binds the signature to the object's identity
 * (repo + head SHA + content hash) without streaming MB through a child
 * process — `contentSha256` already covers the body bytes.
 */
/** The SSHSIG namespace a signer on `signerHost` signs and is verified under. */
export const cacheSigningNamespace = (signerHost: string) => `revv-cache@${signerHost}`;

export function cacheSigningMessage(
  repoFullName: string,
  prHeadSha: string,
  contentSha256: string,
): string {
  return `revv-cache:v1\n${repoFullName}\n${prHeadSha}\n${contentSha256}`;
}
