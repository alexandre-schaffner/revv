export type ModelOption = { label: string; value: string };

const DEFAULT_MODEL_BY_AGENT: Record<'opencode' | 'claude', string> = {
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
