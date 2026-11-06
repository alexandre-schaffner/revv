export interface ContextUsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Compact "1.2K" / "4.3M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function formatPercent(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  if (clamped >= 0.999) return "100%";
  if (clamped < 0.01) return `${(clamped * 100).toFixed(1)}%`;
  return `${(clamped * 100).toFixed(clamped < 0.1 ? 1 : 0)}%`;
}
