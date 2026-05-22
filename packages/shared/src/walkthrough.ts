// ── Block types ─────────────────────────────────────────────────────────────

import type { Activity } from "./activity";

export type AnnotationPosition = "left" | "right";

/** Which phase of the A→B→C→D pipeline a block belongs to. */
export type WalkthroughBlockPhase = "overview" | "diff_analysis" | "sentiment";

export interface BlockPhaseFields {
  /**
   * The pipeline phase this block belongs to. Currently only `'diff_analysis'`
   * is populated at write time — Phase A (overview) lives on
   * `Walkthrough.summary` / `riskLevel`, and Phase C (sentiment) lives on
   * `Walkthrough.sentiment`. The discriminator is carried on every block for
   * forward compatibility with future phases that may produce blocks.
   */
  phase?: WalkthroughBlockPhase;
  /**
   * Monotonic, zero-based index of the parent semantic step. Required when
   * `phase === 'diff_analysis'`. Lets the renderer group atomic blocks under
   * their chapter and lets resume reconstructions know which section each
   * block belongs to.
   */
  semanticStepIndex?: number;
  /**
   * Monotonic, zero-based atomic-block index *within* the parent semantic
   * step. Restarts at 0 in each section. Required when
   * `phase === 'diff_analysis'`. The persistence key is
   * `(walkthroughId, phase, semanticStepIndex, stepIndex)` — retries with
   * the same identity are idempotent upserts.
   */
  stepIndex?: number;
}

export interface MarkdownBlock extends BlockPhaseFields {
  type: "markdown";
  id: string;
  order: number;
  content: string;
}

export interface CodeBlock extends BlockPhaseFields {
  type: "code";
  id: string;
  order: number;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;
  annotation: string | null;
  annotationPosition: AnnotationPosition;
  /**
   * Server-rendered HTML produced by `@pierre/diffs/ssr` (`preloadFile`).
   * When present the client calls `instance.hydrate(...)` and skips the
   * initial worker tokenize round-trip. Absent on cache misses and on
   * live first emit — clients fall back to `instance.render(...)`.
   */
  prerenderedHtml?: string;
}

export interface DiffBlock extends BlockPhaseFields {
  type: "diff";
  id: string;
  order: number;
  filePath: string;
  patch: string;
  annotation: string | null;
  annotationPosition: AnnotationPosition;
  /** See {@link CodeBlock.prerenderedHtml}; produced via `preloadPatchDiff`. */
  prerenderedHtml?: string;
}

export type WalkthroughBlock = MarkdownBlock | CodeBlock | DiffBlock;

// ── Semantic step (Phase B chapter) ─────────────────────────────────────────

/**
 * A "chapter" of the walkthrough body — a meaningful unit of explanation
 * focused on one concept, pattern, or concern that may span multiple files
 * and atomic blocks. Owns 1+ {@link WalkthroughBlock}s linked by
 * `semanticStepIndex`. Written by the `add_semantic_step` MCP tool.
 */
export interface WalkthroughSemanticStep {
  /** Monotonic, zero-based ordering within the walkthrough. */
  semanticStepIndex: number;
  /** Chapter title — the heading shown in the UI. */
  title: string;
  /** Optional 1–2 sentence prelude rendered beneath the chapter title. */
  summary: string | null;
}

// ── Issue (structured concern flagged by the AI agent) ───────────────────────

export interface WalkthroughIssue {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  /**
   * IDs of the walkthrough block(s) that explain this issue. New issues have
   * at least one; legacy rows predating the issue-step linkage may be empty.
   */
  blockIds: string[];
  filePath?: string;
  startLine?: number;
  endLine?: number;
  /**
   * ISO 8601 timestamp recorded when the reviewer submitted this issue to
   * GitHub via the Request Changes flow. Absent = not yet sent. Drives the
   * "already posted" (grayed out) treatment in IssuesPanel and survives
   * across sessions because it's persisted on the walkthrough_issues row.
   */
  submittedAt?: string;
}

// ── Risk & token tracking ───────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high";

export interface WalkthroughTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

// ── Per-axis scorecard ──────────────────────────────────────────────────────

export type RatingAxis =
  | "correctness"
  | "scope"
  | "tests"
  | "clarity"
  | "safety"
  | "consistency"
  | "api_changes"
  | "performance"
  | "description";

/**
 * Canonical order for rendering the scorecard grid. The frontend renders cards
 * in this order regardless of arrival order so the 3×3 layout is stable and
 * reviewers' eyes always land on the same axis in the same spot.
 */
export const RATING_AXES: readonly RatingAxis[] = [
  "correctness",
  "scope",
  "tests",
  "clarity",
  "safety",
  "consistency",
  "api_changes",
  "performance",
  "description",
] as const;

/**
 * Display label for each axis. Used in the scorecard UI; the prompt also
 * references these labels so the model and the UI stay in sync.
 */
export const RATING_AXIS_LABELS: Record<RatingAxis, string> = {
  correctness: "Correctness",
  scope: "Scope",
  tests: "Test coverage",
  clarity: "Clarity",
  safety: "Safety",
  consistency: "Consistency",
  api_changes: "API changes",
  performance: "Performance",
  description: "Description",
};

export type Verdict = "pass" | "concern" | "blocker";
export type Confidence = "low" | "medium" | "high";

export interface RatingCitation {
  filePath: string;
  startLine: number;
  endLine: number;
  note?: string;
}

export interface WalkthroughRating {
  axis: RatingAxis;
  verdict: Verdict;
  confidence: Confidence;
  /** 1–2 sentences. Required for every axis. */
  rationale: string;
  /**
   * Rich GitHub-flavored markdown expanding on the rationale.
   * For pass: what was checked and why it's clean.
   * For concern/blocker: the problem, why it matters, affected paths, and recommended fix.
   */
  details: string;
  /** Required when verdict !== 'pass'. Optional (often empty) for pass. */
  citations: RatingCitation[];
  /** Optional links to walkthrough blocks that explain this rating in depth. */
  blockIds: string[];
}

// ── Pipeline phase (A→B→C→D) ────────────────────────────────────────────────

/**
 * Pointer into the strict 4-phase content pipeline (see "Agent Subsystem
 * Invariants" in the repo root CLAUDE.md).
 *
 *   'none' — nothing persisted yet
 *   'A'    — Phase A (overview + risk) complete
 *   'B'    — Phase B (diff analysis, ≥1 step) complete
 *   'C'    — Phase C (overall sentiment) complete
 *   'D'    — Phase D (all 9 axes rated) complete
 */
export type WalkthroughPipelinePhase = "none" | "A" | "B" | "C" | "D";

/** Job lifecycle status. `WalkthroughJobs.setStatus` is the only writer. */
export type WalkthroughStatus = "generating" | "complete" | "error" | "superseded";

// ── Walkthrough (cached & replayed) ─────────────────────────────────────────

export interface Walkthrough {
  id: string;
  reviewSessionId: string;
  pullRequestId: string;
  summary: string;
  riskLevel: RiskLevel;
  /**
   * Phase C output — "Overall Sentiment" markdown. Null until Phase C completes.
   * Replaces the old convention of a specially-formatted markdown block.
   */
  sentiment: string | null;
  /**
   * Phase B chapters in declaration order. Each chapter owns 0+ entries in
   * `blocks` linked by `semanticStepIndex`. Empty for walkthroughs that
   * never entered Phase B.
   */
  semanticSteps: WalkthroughSemanticStep[];
  blocks: WalkthroughBlock[];
  issues: WalkthroughIssue[];
  ratings: WalkthroughRating[];
  /** Current phase pointer. See {@link WalkthroughPipelinePhase}. */
  lastCompletedPhase: WalkthroughPipelinePhase;
  generatedAt: string;
  modelUsed: string;
  tokenUsage: WalkthroughTokenUsage;
  prHeadSha: string;
  /**
   * ISO 8601 timestamp of the most recent chat-driven edit, or null if the
   * walkthrough has only ever been produced by the generation pipeline. See
   * CLAUDE.md invariant #7 (chat-edit carve-out).
   */
  lastEditedAt?: string | null;
  /**
   * Actor that performed the most recent chat-driven edit. Typically
   * `'chat:claude'` or `'chat:opencode'`. Null when never edited.
   */
  lastEditedBy?: string | null;
  /**
   * GitHub identity of the teammate that triggered the original generation.
   * Null when generated by a pre-migration row. Shown as a
   * "Generated by @login" badge in the walkthrough header.
   */
  generatedBy?: {
    githubUserId: number | null;
    githubLogin: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
  /**
   * AI provider config snapshot from the original run. Shown alongside the
   * generator badge as "claude-opus-4-7 • thinking: high". Null when
   * generated by a pre-migration row.
   */
  providerConfig?: {
    provider: string;
    model: string;
    thinkingEffort: string | null;
    contextWindow: string | null;
    maxTurns: number;
  } | null;
}

// ── MCP read-tool response ──────────────────────────────────────────────────

/**
 * Returned by `get_walkthrough_state` — the MCP read tool that agents call
 * first on every run (including resumes) to reconstruct their context from
 * DB rather than env vars or prompt state.
 */
export interface WalkthroughState {
  walkthroughId: string;
  prHeadSha: string;
  status: WalkthroughStatus;
  lastCompletedPhase: WalkthroughPipelinePhase;
  summary: string | null;
  riskLevel: RiskLevel | null;
  sentiment: string | null;
  /**
   * Semantic-step manifest in `semanticStepIndex` order. Each entry includes
   * the atomic step indices already persisted under it, so the agent can
   * resume either by continuing the in-progress chapter or by opening the
   * next chapter.
   */
  semanticSteps: Array<{
    semanticStepIndex: number;
    title: string;
    summary: string | null;
    stepIndices: number[];
  }>;
  /** Sorted ascending by (semanticStepIndex, stepIndex). */
  diffSteps: Array<{
    semanticStepIndex: number;
    stepIndex: number;
    blockType: WalkthroughBlock["type"];
  }>;
  ratedAxes: RatingAxis[];
  /**
   * Identities of every issue already flagged for this walkthrough. The agent
   * uses these `id` values when calling `add_issue_comment` so resumes can
   * attach line comments to issues from prior runs without re-flagging. Empty
   * for fresh walkthroughs. The order matches insertion order.
   */
  issues: Array<{
    id: string;
    title: string;
    filePath: string | null;
    startLine: number | null;
    endLine: number | null;
  }>;
  /** Convenience — equal to `issues.length`. Retained for forward compatibility. */
  issueCount: number;
  /**
   * Subset of `issues` filtered to entries that REQUIRE an inline review
   * comment but don't yet have one — i.e. severity is `'warning'` or
   * `'critical'` AND `filePath` + `startLine` are both set, AND no
   * `comment_threads` row references the issue. The walkthrough cannot
   * transition to `'complete'` until this list is empty (enforced by
   * `complete_walkthrough` AND the orchestrator). On a resumed run, the
   * agent should call `add_issue_comment` for every entry here before
   * calling `complete_walkthrough`.
   */
  issuesNeedingInlineComment: Array<{
    id: string;
    severity: "warning" | "critical";
    title: string;
    filePath: string;
    startLine: number;
  }>;
}

// ── SSE stream events ───────────────────────────────────────────────────────

/**
 * UI-lifecycle phase (distinct from the content pipeline phase). Drives the
 * phase-progress indicator in the walkthrough header. The content pipeline
 * phase is carried on events where relevant (e.g. `phase:advanced`).
 */
export type WalkthroughLifecyclePhase =
  | "connecting"
  | "exploring"
  | "analyzing"
  | "writing"
  | "rating"
  | "finishing";

/**
 * Why a job started — surfaced on `lifecycle:started` for telemetry and to
 * let the UI tweak its spinner copy. Mirrors the server's `StartJobTrigger`
 * plus `cache-import` for the snapshot-replay fast path. Treat as an open
 * string union; new variants don't break existing clients.
 */
export type WalkthroughStartTrigger = "user" | "resume" | "review_requested" | "cache-import";

export type WalkthroughStreamEvent =
  | { type: "summary"; data: { summary: string; riskLevel: RiskLevel } }
  | { type: "sentiment"; data: { sentiment: string } }
  | { type: "semantic-step"; data: WalkthroughSemanticStep }
  | { type: "block"; data: WalkthroughBlock }
  | { type: "done"; data: { walkthroughId: string; tokenUsage: WalkthroughTokenUsage } }
  | { type: "usage"; data: { tokenUsage: WalkthroughTokenUsage } }
  | { type: "error"; data: { code: string; message: string; repoId?: string } }
  | { type: "exploration"; data: Activity }
  | { type: "issue"; data: WalkthroughIssue }
  | { type: "rating"; data: WalkthroughRating }
  | { type: "phase"; data: { phase: WalkthroughLifecyclePhase; message: string } }
  | {
      type: "phase:advanced";
      data: { lastCompletedPhase: WalkthroughPipelinePhase };
    }
  | { type: "in-progress"; data: { walkthroughId: string } }
  | { type: "thinking"; data: Record<string, never> }
  // ── Lifecycle events (formerly carried as standalone WS envelopes) ───────
  //
  // After the SSE-unification refactor these are folded into the same event
  // stream as content events so the client has one reducer and one cursor
  // per walkthrough. The legacy `walkthrough:complete`, `walkthrough:error`,
  // `walkthrough:cache-hit`, and `walkthrough:edited` WS envelopes are
  // replaced by `lifecycle:*` variants here.
  //
  /**
   * A new generation job started (or an existing one was claimed for
   * resumption). Always the first event emitted for a walkthroughId.
   * `status: "cloning"` indicates the repo is mid-clone — the orchestrator
   * will re-emit a fresh `lifecycle:started` (with `status` omitted) when
   * the clone finishes.
   */
  | {
      type: "lifecycle:started";
      data: {
        walkthroughId: string;
        prHeadSha: string;
        trigger: WalkthroughStartTrigger;
        status?: "cloning";
        repoId?: string;
      };
    }
  /**
   * Generation finished — Phase D validated, `status='complete'`. Replaces
   * the legacy `done` event and the `walkthrough:complete` WS envelope.
   */
  | {
      type: "lifecycle:complete";
      data: { walkthroughId: string; tokenUsage: WalkthroughTokenUsage };
    }
  /**
   * Terminal failure. `code === "CloneInProgress"` is handled specially —
   * the orchestrator will re-emit `lifecycle:started` when the repo clone
   * finishes; no client retry needed.
   */
  | { type: "lifecycle:error"; data: { code: string; message: string; repoId?: string } }
  /**
   * The walkthrough was imported from the team's remote cache rather than
   * generated locally. Purely cosmetic — the actual content events that
   * follow are produced by the importer enumerating the freshly-inserted
   * rows and replaying them as if they had just been written.
   */
  | { type: "lifecycle:cache-hit"; data: { walkthroughId: string; source: "remote" } }
  /**
   * A chat-driven edit landed on a completed walkthrough (CLAUDE.md
   * invariant #7 carve-out). Stamps `lastEditedAt` on the entry; the
   * inner content event that effected the mutation arrives in the
   * same event stream with a subsequent seq.
   */
  | { type: "lifecycle:edited"; data: { walkthroughId: string; editedAt: string } }
  /**
   * This walkthrough was marked `status='superseded'` because a newer
   * one replaced it (typically a fresh PR commit, or a user-driven
   * regenerate that targets the same head SHA via the recycle path).
   * `supersededBy` is the id of the replacement row, when known.
   */
  | {
      type: "lifecycle:superseded";
      data: { walkthroughId: string; supersededBy: string | null };
    }
  // Chat-edit deletion events (CLAUDE.md invariant #7 carve-out). Emitted
  // only via the chat-edit MCP tools after a walkthrough has reached
  // `status='complete'`; never produced by the generation pipeline. Frontend
  // reducer drops the matching item by id / index.
  | {
      type: "block:deleted";
      data: { id: string; semanticStepIndex: number; stepIndex: number };
    }
  | { type: "rating:deleted"; data: { axis: RatingAxis } }
  | { type: "issue:deleted"; data: { id: string } }
  | {
      type: "semantic-step:deleted";
      data: { semanticStepIndex: number };
    };
