export type ModelOption = { label: string; value: string };

// Claude Code fallback list (static — claude CLI has no offline model listing)
export const CLAUDE_CODE_MODELS: ModelOption[] = [
	{ label: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
	{ label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
	{ label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
	{ label: 'Claude Opus 4.5', value: 'claude-opus-4-5-20251101' },
	{ label: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5-20250929' },
	{ label: 'Claude Opus 4.0', value: 'claude-opus-4-20250514' },
	{ label: 'Claude Sonnet 4.0', value: 'claude-sonnet-4-20250514' },
	{ label: 'Claude Haiku 4.0', value: 'claude-haiku-4-20250414' },
];

// Kept for backward compat (used by ModelSelector fallback)
export const MODEL_OPTIONS = CLAUDE_CODE_MODELS;

export const DEFAULT_MODEL_BY_AGENT: Record<'opencode' | 'claude', string> = {
	opencode: 'opencode/big-pickle',
	claude: 'claude-sonnet-4-6',
};

export function getDefaultModel(agent: 'opencode' | 'claude'): string {
	return DEFAULT_MODEL_BY_AGENT[agent];
}

// ThinkingEffort only applies to Claude Code
export function agentSupportsThinkingEffort(agent: 'opencode' | 'claude'): boolean {
	return agent === 'claude';
}
