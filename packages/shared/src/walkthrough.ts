import type { ThinkingEffort } from "./acp-agents";
import type { Activity, ActivityResult } from "./activity";
import type { ExternalAgentProvider } from "./external-integrations";
import type { HunkSmell, WalkthroughLead } from "./hunk-scan";
import type { ReviewMode } from "./review";

/**
 * How much attention a PR needs, and what "Auto" would pick for it, answered
 * before any walkthrough exists.
 *
 * Wire contract of `GET /api/reviews/:id/walkthrough/sizing`.
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

/** Which phase of the A→B→C→D pipeline a block belongs to. */
export type WalkthroughBlockPhase = "overview" | "diff_analysis" | "sentiment";

export interface BlockPhaseFields {
  /**
   * Only `'diff_analysis'` is written: Phase A lives on `Walkthrough.summary`
   * and Phase C on `Walkthrough.sentiment`.
   */
  phase?: WalkthroughBlockPhase;
  /**
   * Monotonic, zero-based index of the parent semantic step. Required when
   * `phase === 'diff_analysis'`.
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
}

export type WalkthroughBlock = MarkdownBlock | CodeBlock | DiffBlock | ArtifactBlock;

/**
 * A "chapter" of the walkthrough body — a meaningful unit of explanation
 * focused on one concept, pattern, or concern that may span multiple files
 * and atomic blocks. Owns 1+ {@link WalkthroughBlock}s linked by
 * `semanticStepIndex`. Written by the `add_semantic_step` MCP tool.
 */
export interface WalkthroughSemanticStep {
  /** Monotonic, zero-based ordering within the walkthrough. */
  semanticStepIndex: number;
  title: string;
  /** Optional 1–2 sentence prelude rendered beneath the chapter title. */
  summary: string | null;
}

/**
 * The number the UI prints in each chapter's "Chapter N / M" eyebrow, keyed
 * by `semanticStepIndex`. The Overview is chapter 0 and carries no number;
 * Phase B chapters are numbered 1..M by position, skipping chapters with no
 * blocks (the UI hides those). Indices may have gaps after chat edits, so the
 * printed number is not `semanticStepIndex + 1` — agents talking to the user
 * about "chapter 3" must map through this, not through the index.
 */
export function chapterNumbersByIndex(
  semanticStepIndices: Iterable<number>,
  blockSemanticStepIndices: Iterable<number>,
): Map<number, number> {
  const withBlocks = new Set(blockSemanticStepIndices);
  const visible = [...new Set(semanticStepIndices)]
    .filter((index) => withBlocks.has(index))
    .sort((a, b) => a - b);
  return new Map(visible.map((index, position) => [index, position + 1]));
}

/**
 * Consequence tier of a flagged concern. Sent by the agent, then relabelled
 * by the Jev relevance pass when Jev is on.
 */
export type IssueSeverity = "info" | "warning" | "critical";

/** Most severe first: the order every issue list renders its severity groups in. */
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = ["critical", "warning", "info"];

export const ISSUE_SEVERITY_LABEL: Readonly<Record<IssueSeverity, string>> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

/** Higher is more severe. */
export function severityRank(severity: IssueSeverity): number {
  return ISSUE_SEVERITIES.length - ISSUE_SEVERITIES.indexOf(severity);
}

export type IssueResolutionStatus = "open" | "addressed" | "wont_fix";

export function isResolvedIssueStatus(
  status: string | null | undefined,
): status is Exclude<IssueResolutionStatus, "open"> {
  return status === "addressed" || status === "wont_fix";
}

export function isIssueResolved(issue: Pick<WalkthroughIssue, "resolutionStatus">): boolean {
  return isResolvedIssueStatus(issue.resolutionStatus);
}

/** Badge text for a resolved issue; null while it is open. */
export function issueResolutionLabel(status: IssueResolutionStatus | undefined): string | null {
  if (status === "addressed") return "Addressed";
  if (status === "wont_fix") return "Won't fix";
  return null;
}

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
   * GitHub via the Request Changes flow. Absent = not yet sent.
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
  /** Local implementation lifecycle; omitted on legacy/open issues. */
  resolutionStatus?: IssueResolutionStatus;
  resolutionExplanation?: string;
  resolutionEvidence?: string[];
  resolvingCommitSha?: string;
  resolvedAt?: string;
  resolvedBy?: ExternalAgentProvider;
}

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
   * Agent-reported context window for the active model (ACP `usage_update`
   * `size`). Omitted when the agent doesn't report it, so consumers fall back
   * to a configured window.
   */
  contextWindowTokens?: number;
}

export const ZERO_TOKEN_USAGE: WalkthroughTokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  contextTokens: 0,
});

/** A token usage as any version of Revv recorded it; missing or non-numeric fields read as 0. */
export function normalizeTokenUsage(value: unknown): WalkthroughTokenUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ZERO_TOKEN_USAGE;
  const r = value as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inputTokens = num(r.inputTokens);
  const outputTokens = num(r.outputTokens);
  const cacheReadInputTokens = num(r.cacheReadInputTokens);
  const cacheCreationInputTokens = num(r.cacheCreationInputTokens);
  const contextWindowTokens = num(r.contextWindowTokens);
  // Walkthroughs from before context occupancy was tracked carry no
  // `contextTokens`; the throughput sum keeps their gauge populated.
  const contextTokens =
    typeof r.contextTokens === "number" && Number.isFinite(r.contextTokens)
      ? r.contextTokens
      : inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    contextTokens,
    ...(contextWindowTokens > 0 ? { contextWindowTokens } : {}),
  };
}

/**
 * Canonical order for the 3×3 scorecard grid, regardless of arrival order, so
 * each axis always lands in the same spot.
 */
export const RATING_AXES = [
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

export type RatingAxis = (typeof RATING_AXES)[number];

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

/**
 * Composite score below which an issue is treated as low signal. Kept low:
 * a false positive here hides a real bug behind a disclosure.
 */
export const LOW_SIGNAL_THRESHOLD = 0.4;

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

export function isDiscardedScore(score: number | null | undefined): boolean {
  return typeof score === "number" && score < ISSUE_DISCARD_THRESHOLD;
}

/**
 * Pointer into the strict 4-phase content pipeline (see "Agent Subsystem
 * Invariants" in the repo root CLAUDE.md).
 *
 *   'none' — nothing persisted yet
 *   'A'    — Phase A (overview) complete
 *   'B'    — Phase B (diff analysis, ≥1 step) complete
 *   'C'    — Phase C (overall sentiment) complete
 *   'D'    — Phase D (all 9 axes rated) complete
 */
export type WalkthroughPipelinePhase = "none" | "A" | "B" | "C" | "D";

/** Job lifecycle status. WalkthroughJobs is the only writer. */
export type WalkthroughStatus = "generating" | "complete" | "error" | "superseded";

/**
 * Why a run ended without completing, recorded on the row
 * (`walkthroughs.end_reason`) and carried by `lifecycle:error`. Null while a
 * row is generating and once it completed.
 */
export const WALKTHROUGH_END_REASONS = [
  /** The user's Stop. */
  "cancelled",
  /** A newer head or a Regenerate replaced the run. */
  "superseded",
  /** Auto-continuations ran out, or were judged doomed, before the review was finished. */
  "budget_exhausted",
  /** The run crashed more often than its resume budget allows. */
  "resume_budget",
  /** The agent needs its user to sign in again. */
  "agent_auth",
  /** The agent failed or declined to continue. */
  "agent_error",
  /** The agent's turn timed out before anything was written. */
  "timeout_no_content",
  /** The agent finished without writing anything. */
  "no_content",
  /** The repository clone the run waited on failed or never happened. */
  "clone_failed",
  /** The run itself failed before or around the agent (worktree, diff, database). */
  "crashed",
] as const;

export type WalkthroughEndReason = (typeof WALKTHROUGH_END_REASONS)[number];

/**
 * How a walkthrough row was produced.
 *
 * `full` analyzes the current PR diff without using a prior walkthrough as
 * input. `incremental` still produces the same report shape, but the agent is
 * expected to use the linked prior walkthrough and the new commit range as its
 * starting point.
 */
export const WALKTHROUGH_GENERATION_MODES = ["full", "incremental"] as const;
export type WalkthroughGenerationMode = (typeof WALKTHROUGH_GENERATION_MODES)[number];

export interface WalkthroughReviewRound {
  id: string;
  walkthroughId: string;
  previousWalkthroughId: string | null;
  roundNumber: number;
  kind: WalkthroughGenerationMode;
  /** The perspective the round's walkthrough was written in. History spans
   *  both: switching perspective retires the other one's walkthrough, and
   *  its rounds stay readable here. */
  mode: WalkthroughMode;
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
  /**
   * The first-pass leads this walkthrough's agent was handed, with its
   * verdicts. Null when the row predates lead tracking or came
   * from the remote cache — then only where its issues sit says anything.
   */
  leads: WalkthroughLead[] | null;
  lastCompletedPhase: WalkthroughPipelinePhase;
  /** Last terminal generation failure, if this row is in `status='error'`. */
  errorMessage?: string | null;
  /** Why the run ended, when it ended without completing. */
  endReason?: WalkthroughEndReason | null;
  generatedAt: string;
  modelUsed: string;
  tokenUsage: WalkthroughTokenUsage;
  prHeadSha: string;
  generationMode?: WalkthroughGenerationMode;
  parentWalkthroughId?: string | null;
  baseHeadSha?: string | null;
  /**
   * ISO 8601 timestamp of the most recent chat-driven edit, or null if the
   * walkthrough has only ever been produced by the generation pipeline
   * (CLAUDE.md invariant #7, chat-edit carve-out).
   */
  lastEditedAt?: string | null;
  /**
   * Actor of the most recent edit: `'chat:acp'` or an external coding agent's
   * provider id. Null when never edited.
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
  ratedAxes: RatingAxis[];
  /**
   * Every issue already flagged, in insertion order. A resumed agent passes
   * these ids to `add_issue_comment` instead of re-flagging.
   */
  issues: Array<{
    id: string;
    title: string;
    filePath: string | null;
    startLine: number | null;
    endLine: number | null;
  }>;
  issueCount: number;
  /**
   * Line-anchored issues (`filePath` + `startLine` set) that no
   * `comment_threads` row references yet. The walkthrough cannot become
   * `'complete'` until this is empty (checked by `complete_walkthrough` and
   * the orchestrator).
   */
  issuesNeedingInlineComment: Array<{
    id: string;
    severity: IssueSeverity;
    title: string;
    filePath: string;
    startLine: number;
  }>;
  /** The first-pass leads this run was handed, in prompt order, with any verdict given. */
  leads: Array<
    Pick<WalkthroughLead, "id" | "filePath" | "newStart" | "newLines" | "verdict" | "issueId"> & {
      smells: HunkSmell[];
    }
  >;
  /**
   * Ids from `leads` with no verdict yet. `complete_walkthrough` refuses
   * until it is empty; the orchestrator does not wait on it.
   */
  leadsNeedingVerdict: string[];
}

/**
 * UI-lifecycle phase, distinct from the content pipeline phase (which
 * `phase:advanced` carries).
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
 * let the UI tweak its spinner copy. Every `StartJobTrigger`, plus
 * `cache-import` for the snapshot-replay fast path. Treat as an open string
 * union; new variants don't break existing clients.
 */
export type WalkthroughStartTrigger =
  | "user"
  | "external_agent"
  | "resume"
  | "review_requested"
  | "stack_review"
  | "cache-import";

/**
 * Who asked the server to run a walkthrough job. `external_agent` is a
 * coding agent outside Revv (`request_walkthrough`) acting on the user's
 * behalf, so it gets the same do-over semantics as `user`; it is its own
 * value so spans and `lifecycle:started` can tell the two apart.
 */
export type StartJobTrigger = Exclude<WalkthroughStartTrigger, "cache-import">;

/**
 * What only matters while a run is live: the agent's reasoning, its own tool
 * calls, the context gauge and a coarse phase. Broadcast unsequenced on
 * `walkthrough:live` and never journaled, so a client that misses one has
 * lost nothing it could re-read.
 */
export type WalkthroughLiveEvent =
  | { type: "usage"; data: { tokenUsage: WalkthroughTokenUsage } }
  | { type: "exploration"; data: Activity }
  /**
   * Terminal output of a previously-streamed `exploration` tool call,
   * correlated by `callId`, for the pill's output peek.
   */
  | { type: "exploration-result"; data: ActivityResult }
  /**
   * Late-arriving tool input for a previously-streamed `exploration` pill,
   * correlated by `callId`, when the agent only supplies it after the call.
   */
  | { type: "exploration-input"; data: { callId: string; payload: unknown } }
  | { type: "phase"; data: { phase: WalkthroughLifecyclePhase; message: string } }
  | { type: "thought"; data: { text: string } };

/**
 * Content and lifecycle: every one is committed before it is sent and carries
 * the walkthrough's durable seq on `walkthrough:event`, so a client that
 * reconnects reconciles by re-reading the row.
 */
export type WalkthroughDurableEvent =
  | { type: "summary"; data: { summary: string; riskLevel: RiskLevel } }
  | { type: "sentiment"; data: { sentiment: string } }
  | { type: "semantic-step"; data: WalkthroughSemanticStep }
  | { type: "block"; data: WalkthroughBlock }
  | { type: "issue"; data: WalkthroughIssue }
  /**
   * The leads this run's agent was handed, recorded at job start before the
   * prompt goes out. Full state: replaces whatever the client held.
   */
  | { type: "leads"; data: { leads: WalkthroughLead[] } }
  /** A lead's verdict landed (`resolve_lead`). Full state for that lead. */
  | { type: "lead"; data: WalkthroughLead }
  | { type: "rating"; data: WalkthroughRating }
  | {
      type: "phase:advanced";
      data: { lastCompletedPhase: WalkthroughPipelinePhase };
    }
  /** A run started on this row (fresh, resumed, or waiting on its clone). */
  | {
      type: "lifecycle:started";
      data: {
        walkthroughId: string;
        prHeadSha: string;
        mode?: WalkthroughMode;
        trigger: WalkthroughStartTrigger;
        /**
         * Risk tier, when the orchestrator assigned it before launching the
         * agent — known seconds before the Phase A `summary` event. Absent
         * when the agent owns the tier.
         */
        riskLevel?: RiskLevel;
        /** The model this run launches with, resolved against the agent's catalog. */
        modelUsed?: string;
      };
    }
  /** The journal passed the completion check and the row is `complete`. */
  | {
      type: "lifecycle:complete";
      data: { walkthroughId: string; tokenUsage: WalkthroughTokenUsage };
    }
  /** The row is `error`; `reason` says why. */
  | { type: "lifecycle:error"; data: { reason: WalkthroughEndReason; message: string } }
  /**
   * The walkthrough was imported rather than generated: from the team's
   * remote cache (`remote`), or carried from this PR's previous head because
   * a restack left the layer's own changes byte-identical (`restack`).
   * Clients re-hydrate the imported content via `/current`.
   */
  | {
      type: "lifecycle:cache-hit";
      data: { walkthroughId: string; source: "remote" | "restack" };
    }
  /**
   * A chat-driven edit landed on a completed walkthrough (CLAUDE.md
   * invariant #7 carve-out). The content event that effected the mutation
   * arrives in the same stream with a later seq.
   */
  | { type: "lifecycle:edited"; data: { walkthroughId: string; editedAt: string } }
  /**
   * This walkthrough was marked `status='superseded'`: a newer head, a
   * Regenerate, or a fresh run at the same head replaced it. `supersededBy`
   * is the replacement's id, when known.
   */
  | {
      type: "lifecycle:superseded";
      data: { walkthroughId: string; supersededBy: string | null };
    }
  // Deletions: chat-edit tools on a completed walkthrough, and a background
  // relevance judgment retracting a concern during generation (`issue:deleted`).
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

/** Anything a walkthrough announces; `WalkthroughJobs.emitEvent` routes it by kind. */
export type WalkthroughStreamEvent = WalkthroughDurableEvent | WalkthroughLiveEvent;

// A record, not a list, so a live type added to the union without a key here
// fails to compile instead of being journaled as durable.
const LIVE_EVENT_TYPES: Record<WalkthroughLiveEvent["type"], true> = {
  usage: true,
  exploration: true,
  "exploration-result": true,
  "exploration-input": true,
  phase: true,
  thought: true,
};

export function isWalkthroughLiveEvent(
  event: WalkthroughStreamEvent,
): event is WalkthroughLiveEvent {
  return Object.hasOwn(LIVE_EVENT_TYPES, event.type);
}
