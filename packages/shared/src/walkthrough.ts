// ── Block types ─────────────────────────────────────────────────────────────

export type AnnotationPosition = 'left' | 'right';

export interface MarkdownBlock {
	type: 'markdown';
	id: string;
	order: number;
	content: string;
}

export interface CodeBlock {
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

export interface DiffBlock {
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
}

/**
 * A WalkthroughIssue carried over from a previous generation, enriched with
 * the original block annotation text so the agent can reassess it.
 */
export interface CarriedOverIssue extends WalkthroughIssue {
	/** Combined text of the original block annotations that explained this issue. */
	originalContext: string;
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

// ── Walkthrough (cached & replayed) ─────────────────────────────────────────

export interface Walkthrough {
	id: string;
	reviewSessionId: string;
	pullRequestId: string;
	summary: string;
	riskLevel: RiskLevel;
	blocks: WalkthroughBlock[];
	issues: WalkthroughIssue[];
	ratings: WalkthroughRating[];
	generatedAt: string;
	modelUsed: string;
	tokenUsage: WalkthroughTokenUsage;
	prHeadSha: string;
}

// ── SSE stream events ───────────────────────────────────────────────────────

export type WalkthroughPhase = 'connecting' | 'exploring' | 'analyzing' | 'writing' | 'rating' | 'finishing';

export type WalkthroughStreamEvent =
	| { type: 'summary'; data: { summary: string; riskLevel: RiskLevel } }
	| { type: 'block'; data: WalkthroughBlock }
	| { type: 'done'; data: { walkthroughId: string; tokenUsage: WalkthroughTokenUsage } }
	| { type: 'error'; data: { code: string; message: string } }
	| { type: 'exploration'; data: { tool: string; description: string } }
	| { type: 'issue'; data: WalkthroughIssue }
	| { type: 'rating'; data: WalkthroughRating }
	| { type: 'phase'; data: { phase: WalkthroughPhase; message: string } }
	| { type: 'in-progress'; data: { walkthroughId: string } };
