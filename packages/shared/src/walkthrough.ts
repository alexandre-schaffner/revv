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
	filePath?: string;
	startLine?: number;
	endLine?: number;
}

// ── Risk & token tracking ───────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high';

export interface WalkthroughTokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
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
	generatedAt: string;
	modelUsed: string;
	tokenUsage: WalkthroughTokenUsage;
	prHeadSha: string;
}

// ── SSE stream events ───────────────────────────────────────────────────────

export type WalkthroughPhase = 'connecting' | 'exploring' | 'analyzing' | 'writing' | 'finishing';

export type WalkthroughStreamEvent =
	| { type: 'summary'; data: { summary: string; riskLevel: RiskLevel } }
	| { type: 'block'; data: WalkthroughBlock }
	| { type: 'done'; data: { walkthroughId: string; tokenUsage: WalkthroughTokenUsage } }
	| { type: 'error'; data: { code: string; message: string } }
	| { type: 'exploration'; data: { tool: string; description: string } }
	| { type: 'issue'; data: WalkthroughIssue }
	| { type: 'phase'; data: { phase: WalkthroughPhase; message: string } }
	| { type: 'in-progress'; data: { walkthroughId: string } };
