import type { ThinkingEffort } from '@revv/shared';

export type ModelOption = { label: string; value: string };

export const THINKING_EFFORT_OPTIONS: { label: string; value: ThinkingEffort }[] = [
	{ label: 'Ultrathink', value: 'ultrathink' },
	{ label: 'Max', value: 'max' },
	{ label: 'Extra High', value: 'extra-high' },
	{ label: 'High', value: 'high' },
	{ label: 'Medium', value: 'medium' },
	{ label: 'Low', value: 'low' },
];

/** Thinking effort values that are only available for Claude Opus 4.7. */
export const OPUS_ONLY_EFFORTS: Set<ThinkingEffort> = new Set(['max', 'extra-high']);

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

// ContextWindow only applies to Claude Code
export function agentSupportsContextWindow(agent: 'opencode' | 'claude'): boolean {
	return agent === 'claude';
}
