// ── Structured logging ──────────────────────────────────────────────────────
// Lightweight logger that wraps console.error. Debug messages are gated
// behind the REV_DEBUG=1 env var so they don't pollute production output.

const DEBUG = process.env['REV_DEBUG'] === '1';

/** Log a debug message. Only emits output when REV_DEBUG=1. */
export function debug(tag: string, ...args: unknown[]): void {
	if (DEBUG) console.error(`[${tag}]`, ...args);
}

/** Log an error message. Always emits output. */
export function logError(tag: string, ...args: unknown[]): void {
	console.error(`[${tag}]`, ...args);
}
