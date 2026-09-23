// ── Block types ─────────────────────────────────────────────────────────────

import type { Activity, ActivityResult } from "./activity";
import type { ReviewMode, ThinkingEffort } from "./types";

/**
 * How much attention a PR needs, and what "Auto" would pick for it, answered
 * before any walkthrough exists.
 *
 * Wire contract of `GET /api/reviews/:id/walkthrough/sizing`, shared so the
 * handler's return and the store's `res.json()` can't drift out of sync.
 */
export type WalkthroughSizing =
  /** No auto half in play and the risk hook is off. */
  | { readonly status: "off" }
  /** A hook is on, but the diff isn't cached yet. */
  | { readonly status: "pending" }
  | {
      readonly status: "ready";
      /** Tier this PR would be sized to. Null when the risk hook is off. */
      readonly riskLevel: RiskLevel | null;
      /** Model this PR would launch with. Null when pinned or routing declined. */
      readonly model: string | null;
      /**
       * Reasoning effort, already clamped to the agent's ladder. Null when
       * pinned or declined — independent of {@link WalkthroughSizing.model},
       * which has its own opt-in and gating.
       */
      readonly thinkingEffort: ThinkingEffort | null;
    };

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

export interface ArtifactBlock extends BlockPhaseFields {
  type: "artifact";
  id: string;
  order: number;
  /** Complete self-contained HTML document rendered in a sandboxed iframe. */
  html: string;
  annotation: string | null;
  annotationPosition: AnnotationPosition;
}

export type WalkthroughBlock = MarkdownBlock | CodeBlock | DiffBlock | ArtifactBlock;

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

/**
 * Consequence tier of a flagged concern. Decided by the agent, or by the
 * relevance pass when `jev.issueSeverity` is on — both name this closed set.
 */
export type IssueSeverity = "info" | "warning" | "critical";

export interface WalkthroughIssue {
  id: string;
  severity: IssueSeverity;
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
  /**
   * Composite signal score in [0,1] from the orchestrator's issue-scoring
   * pass. Absent = never scored (pre-Jev rows, cache-imported walkthroughs);
   * unscored is never treated as low-signal.
   */
  advisoryScore?: number;
  /**
   * True when {@link advisoryScore} is below the low-signal threshold.
   * Computed server-side so every surface filters identically.
   */
  lowSignal?: boolean;
}

// ── Risk & token tracking ───────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high";

export type WalkthroughMode = ReviewMode;

export interface WalkthroughTokenUsage {
  /**
   * Throughput totals used for billing/debug breakdowns. These count tokens
   * processed across a run and may exceed the active model context window.
   */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /**
   * Point-in-time context occupancy for the latest model call: the full prompt
   * (including cached tokens) plus that call's output. This — not the
   * throughput totals above — is what context-window gauges should read.
   * Always present; `0` means "unknown / none observed yet".
   */
  contextTokens: number;
  /**
   * Provider-reported context window for the active model. Only some providers
   * report this (e.g. the Claude Agent SDK); the sole optional field, omitted
   * when unavailable so consumers fall back to a configured window.
   */
  contextWindowTokens?: number;
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
  /** Who decided {@link verdict}: `'agent'`, or `'advisory'` when Jev pre-assigned it and the agent wrote prose only. */
  verdictSource?: VerdictSource;
  /**
   * Set when the agent was handed a non-`pass` verdict it couldn't cite for.
   * Doesn't change the verdict — the only agent/advisory disagreement signal
   * left once verdicts are pre-assigned.
   */
  disputed?: boolean;
}

/** Origin of a {@link WalkthroughRating.verdict}. */
export type VerdictSource = "agent" | "advisory";

/**
 * Durable gate for the orchestrator's phase-D verdict pass, read by
 * `rate_axis` to decide whether the agent supplies a verdict or prose only.
 *
 *   'pending'     — pass in flight; `rate_axis` returns a retryable error.
 *   'ready'       — nine rating rows pre-seeded with verdicts.
 *   'unavailable' — pass skipped/failed; pre-Jev contract applies.
 *
 * Null means `'unavailable'`; every row predating the feature holds it.
 */
export type AxisAdvisoryState = "pending" | "ready" | "unavailable";

/**
 * Composite score below which an issue is treated as low signal. Kept low:
 * a false positive here hides a real bug behind a disclosure. Shared so the
 * server's DTO and client-side reasoning can't drift.
 */
export const LOW_SIGNAL_THRESHOLD = 0.4;

/** True when a scored issue falls below {@link LOW_SIGNAL_THRESHOLD}. */
export function isLowSignalScore(score: number | null | undefined): boolean {
  return typeof score === "number" && score < LOW_SIGNAL_THRESHOLD;
}

/**
 * Composite score below which a flagged concern is never recorded at all.
 *
 * Two tiers, not one: collapsing behind a disclosure is recoverable, but
 * discarding means the reader never learns the concern existed, so this
 * floor sits well below {@link LOW_SIGNAL_THRESHOLD} and only catches
 * ungrounded, out-of-scope, or duplicate concerns. `compositeScore` pins
 * anything the agent called `critical` to 1, so it can never reach either
 * threshold.
 */
export const ISSUE_DISCARD_THRESHOLD = 0.2;

/** True when a scored concern falls below {@link ISSUE_DISCARD_THRESHOLD}. */
export function isDiscardedScore(score: number | null | undefined): boolean {
  return typeof score === "number" && score < ISSUE_DISCARD_THRESHOLD;
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

/**
 * How a walkthrough row was produced.
 *
 * `full` analyzes the current PR diff without using a prior walkthrough as
 * input. `incremental` still produces the same report shape, but the agent is
 * expected to use the linked prior walkthrough and the new commit range as its
 * starting point.
 */
export type WalkthroughGenerationMode = "full" | "incremental";

export interface WalkthroughReviewRound {
  id: string;
  walkthroughId: string;
  previousWalkthroughId: string | null;
  roundNumber: number;
  kind: WalkthroughGenerationMode;
  visibility: "visible" | "hidden";
  status: WalkthroughStatus;
  fromSha: string | null;
  toSha: string;
  createdAt: string;
  completedAt: string | null;
  summary: string | null;
  focusTitle: string | null;
  prHeadSha: string;
}

export interface WalkthroughReviewRoundsResponse {
  prId: string;
  currentHeadSha: string | null;
  latestReviewedHeadSha: string | null;
  hasNewCommits: boolean;
  nextBaseHeadSha: string | null;
  rounds: WalkthroughReviewRound[];
}

// ── Walkthrough (cached & replayed) ─────────────────────────────────────────

export interface Walkthrough {
  id: string;
  reviewSessionId: string;
  pullRequestId: string;
  mode: WalkthroughMode;
  summary: string;
  riskLevel: RiskLevel;
  /**
   * Calibrated confidence behind {@link riskLevel}, or null when the tier
   * came from the agent rather than the orchestrator's risk pass. Consumers
   * treat non-null as "tier is authoritative" — a generating row's schema
   * default `'low'` isn't a real verdict until confidence is present.
   */
  riskConfidence?: number | null;
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
  /** Last terminal generation failure, if this row is in `status='error'`. */
  errorMessage?: string | null;
  generatedAt: string;
  modelUsed: string;
  tokenUsage: WalkthroughTokenUsage;
  prHeadSha: string;
  generationMode?: WalkthroughGenerationMode;
  parentWalkthroughId?: string | null;
  baseHeadSha?: string | null;
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
    avatarContent: string | null;
  } | null;
  /**
   * AI provider config snapshot from the original run. Shown alongside the
   * generator badge as "claude-opus-4-8 • thinking: high". Null when
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
  mode: WalkthroughMode;
  generationMode: WalkthroughGenerationMode;
  parentWalkthroughId: string | null;
  baseHeadSha: string | null;
  priorReview: {
    walkthroughId: string;
    prHeadSha: string;
    summary: string;
    riskLevel: RiskLevel;
    sentiment: string | null;
    semanticSteps: Array<{
      semanticStepIndex: number;
      title: string;
      summary: string | null;
    }>;
    issues: Array<{
      id: string;
      severity: WalkthroughIssue["severity"];
      title: string;
      description: string;
      filePath: string | null;
      startLine: number | null;
      endLine: number | null;
      submittedAt: string | null;
    }>;
    ratings: Array<{
      axis: RatingAxis;
      verdict: Verdict;
      confidence: Confidence;
      rationale: string;
    }>;
  } | null;
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
  /**
   * Whether the orchestrator's phase-D verdict pass has landed, and so
   * whether `rate_axis` expects a verdict from the agent or only prose.
   *
   *   'pending'     — pass in flight; `rate_axis` returns a retryable error.
   *   'ready'       — verdicts pre-assigned; supply prose, use
   *                   `disputed: true` for an axis you can't cite.
   *   'unavailable' — supply the verdict yourself, as before.
   *
   * Null means `'unavailable'`. Invariant 6 covers resume for free — read
   * from DB every run rather than carried in memory.
   */
  axisAdvisoryState: AxisAdvisoryState | null;
  /**
   * The nine verdicts, when {@link axisAdvisoryState} is `'ready'`; `null`
   * otherwise. Tells the agent which call it's justifying — `rate_axis`
   * takes no verdict in that mode. Lists only seeded axes; a missing axis
   * still expects a verdict from the agent.
   */
  assignedVerdicts: Array<{
    axis: RatingAxis;
    verdict: Verdict;
    confidence: Confidence;
  }> | null;
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
   * comment but don't yet have one — i.e. `filePath` + `startLine` are both set, AND no
   * `comment_threads` row references the issue. The walkthrough cannot
   * transition to `'complete'` until this list is empty (enforced by
   * `complete_walkthrough` AND the orchestrator). On a resumed run, the
   * agent should call `add_issue_comment` for every entry here before
   * calling `complete_walkthrough`.
   */
  issuesNeedingInlineComment: Array<{
    id: string;
    severity: IssueSeverity;
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
  /**
   * Terminal output of a previously-streamed `exploration` tool call,
   * correlated by `callId`. Lets the live walkthrough feed attach a clickable
   * output peek (e.g. a Bash command's stdout) to the matching exploration
   * pill. Transient — not persisted (walkthrough exploration is live-only).
   */
  | { type: "exploration-result"; data: ActivityResult }
  /**
   * Late-arriving tool input for a previously-streamed `exploration` pill,
   * correlated by `callId` — patches its payload so the filename/command and
   * file peek resolve when the agent only supplies them after the tool-call.
   */
  | { type: "exploration-input"; data: { callId: string; payload: unknown } }
  | { type: "issue"; data: WalkthroughIssue }
  | { type: "rating"; data: WalkthroughRating }
  | { type: "phase"; data: { phase: WalkthroughLifecyclePhase; message: string } }
  | {
      type: "phase:advanced";
      data: { lastCompletedPhase: WalkthroughPipelinePhase };
    }
  | { type: "in-progress"; data: { walkthroughId: string } }
  | { type: "thinking"; data: Record<string, never> }
  /**
   * Streamed model reasoning text. Mirrors the recap `thought` event and is
   * separate from `thinking` (which is the empty stream-guard heartbeat).
   * Forwarded from agent-side `reasoning-delta` events; not persisted to
   * SQLite — only meaningful during live generation.
   */
  | { type: "thought"; data: { text: string } }
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
        mode?: WalkthroughMode;
        trigger: WalkthroughStartTrigger;
        status?: "cloning";
        repoId?: string;
        /**
         * Risk tier, when the orchestrator assigned it before launching the
         * agent — known seconds before the Phase A `summary` event. Absent
         * when the agent owns the tier; `summary` is then the first place
         * it appears.
         */
        riskLevel?: RiskLevel;
        /**
         * The model this run actually launched with, resolved against the
         * agent's catalog. Lets a UI showing "Auto" name what it picked,
         * including when routing declined and the configured model stood.
         */
        modelUsed?: string;
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
