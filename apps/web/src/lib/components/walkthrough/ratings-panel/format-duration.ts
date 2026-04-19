/**
 * Format a millisecond duration for display in the ratings panel duration chip.
 *
 * Mirrors the style used by unit test runners (Vitest, Jest) so the UI reads
 * like terminal test output:
 *   - Under 10ms collapses to "0ms" to avoid jitter from sub-tick noise.
 *   - Under 1s renders as integer milliseconds: "340ms".
 *   - 1s and up renders as one decimal second: "1.8s".
 */
export function formatDuration(ms: number): string {
	if (ms < 10) return '0ms';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}
