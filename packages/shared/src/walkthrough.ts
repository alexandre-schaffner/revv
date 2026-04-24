// ── Block types ─────────────────────────────────────────────────────────────

export type AnnotationPosition = 'left' | 'right';

/** Which phase of the A→B→C→D pipeline a block belongs to. */
export type WalkthroughBlockPhase = 'overview' | 'diff_analysis' | 'sentiment';

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
	 * Monotonic, zero-based step index within Phase B. Required when
	 * `phase === 'diff_analysis'`. Agents pass this explicitly so
	 * `(walkthroughId, phase, stepIndex)` upserts are idempotent.
	 */
	stepIndex?: number;
}

export interface MarkdownBlock extends BlockPhaseFields {
	type: 'markdown';
	id: string;
	order: number;
	content: string;
}

export interface CodeBlock extends BlockPhaseFields {
	type: 'code';
	id: string;
	order: number;
	filePath: string;
	startLine: number;
	endLine: number;
	language: string;
	content: string;
	annotation: string | null;
	annotationPosition: AnnotationPosition;
}

export interface DiffBlock extends BlockPhaseFields {
	type: 'diff';
	id: string;
	order: number;
	filePath: string;
	patch: string;
	annotation: string | null;
	annotationPosition: AnnotationPosition;
}

export type WalkthroughBlock = MarkdownBlock | CodeBlock | DiffBlock;

// ── Issue (structured concern flagged by the AI agent) ───────────────────────

export interface WalkthroughIssue {
	id: string;
	severity: 'info' | 'warning' | 'critical';
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

export type RiskLevel = 'low' | 'medium' | 'high';

export interface WalkthroughTokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

// ── Per-axis scorecard ──────────────────────────────────────────────────────

export type RatingAxis =
	| 'correctness'
	| 'scope'
	| 'tests'
	| 'clarity'
	| 'safety'
	| 'consistency'
	| 'api_changes'
	| 'performance'
	| 'description';

/**
 * Canonical order for rendering the scorecard grid. The frontend renders cards
 * in this order regardless of arrival order so the 3×3 layout is stable and
 * reviewers' eyes always land on the same axis in the same spot.
 */
export const RATING_AXES: readonly RatingAxis[] = [
	'correctness',
	'scope',
	'tests',
	'clarity',
	'safety',
	'consistency',
	'api_changes',
	'performance',
	'description',
] as const;

/**
 * Display label for each axis. Used in the scorecard UI; the prompt also
 * references these labels so the model and the UI stay in sync.
 */
export const RATING_AXIS_LABELS: Record<RatingAxis, string> = {
	correctness: 'Correctness',
	scope: 'Scope',
	tests: 'Test coverage',
	clarity: 'Clarity',
	safety: 'Safety',
	consistency: 'Consistency',
	api_changes: 'API changes',
	performance: 'Performance',
	description: 'Description',
};

export type Verdict = 'pass' | 'concern' | 'blocker';
export type Confidence = 'low' | 'medium' | 'high';

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
export type WalkthroughPipelinePhase = 'none' | 'A' | 'B' | 'C' | 'D';

/** Job lifecycle status. `WalkthroughJobs.setStatus` is the only writer. */
export type WalkthroughStatus = 'generating' | 'complete' | 'error' | 'superseded';

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
	blocks: WalkthroughBlock[];
	issues: WalkthroughIssue[];
	ratings: WalkthroughRating[];
	/** Current phase pointer. See {@link WalkthroughPipelinePhase}. */
	lastCompletedPhase: WalkthroughPipelinePhase;
	generatedAt: string;
	modelUsed: string;
	tokenUsage: WalkthroughTokenUsage;
	prHeadSha: string;
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
	/** Sorted ascending by `stepIndex`. Missing indices mean "not yet persisted." */
	diffSteps: Array<{
		stepIndex: number;
		blockType: WalkthroughBlock['type'];
	}>;
	ratedAxes: RatingAxis[];
	issueCount: number;
}

// ── SSE stream events ───────────────────────────────────────────────────────

/**
 * UI-lifecycle phase (distinct from the content pipeline phase). Drives the
 * phase-progress indicator in the walkthrough header. The content pipeline
 * phase is carried on events where relevant (e.g. `phase:advanced`).
 */
export type WalkthroughLifecyclePhase =
	| 'connecting'
	| 'exploring'
	| 'analyzing'
	| 'writing'
	| 'rating'
	| 'finishing';

export type WalkthroughStreamEvent =
	| { type: 'summary'; data: { summary: string; riskLevel: RiskLevel } }
	| { type: 'sentiment'; data: { sentiment: string } }
	| { type: 'block'; data: WalkthroughBlock }
	| { type: 'done'; data: { walkthroughId: string; tokenUsage: WalkthroughTokenUsage } }
	| { type: 'error'; data: { code: string; message: string; repoId?: string } }
	| { type: 'exploration'; data: { tool: string; description: string } }
	| { type: 'issue'; data: WalkthroughIssue }
	| { type: 'rating'; data: WalkthroughRating }
	| { type: 'phase'; data: { phase: WalkthroughLifecyclePhase; message: string } }
	| {
			type: 'phase:advanced';
			data: { lastCompletedPhase: WalkthroughPipelinePhase };
	  }
	| { type: 'in-progress'; data: { walkthroughId: string } };
