import { getContext, setContext } from 'svelte';

const CONTEXT_KEY = Symbol('ai-context');

export type ContextUsage = {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
};

export type ContextState = {
	usedTokens: number;
	maxTokens: number;
	usage?: ContextUsage | undefined;
	/** Optional pre-computed cost breakdown in USD. Omitted ⇒ footer hides. */
	cost?: ContextCost | undefined;
};

export type ContextCost = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheCreation?: number;
	total?: number;
};

export type ContextStateGetter = () => ContextState;

export function setContextState(getter: ContextStateGetter) {
	setContext(CONTEXT_KEY, getter);
}

export function getContextState(): ContextStateGetter {
	const getter = getContext<ContextStateGetter | undefined>(CONTEXT_KEY);
	if (!getter) {
		throw new Error('Context components must be used within <Context>');
	}
	return getter;
}

/** Compact "1.2K" / "4.3M" formatter used in trigger + rows. */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '0';
	if (n < 1_000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
	if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
	return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function formatPercent(ratio: number): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	if (clamped >= 0.999) return '100%';
	if (clamped < 0.01) return `${(clamped * 100).toFixed(1)}%`;
	return `${(clamped * 100).toFixed(clamped < 0.1 ? 1 : 0)}%`;
}

export function formatCost(usd: number | undefined): string | null {
	if (usd === undefined || !Number.isFinite(usd)) return null;
	if (usd === 0) return '$0.00';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}
