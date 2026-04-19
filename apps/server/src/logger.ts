// ── Structured logging ──────────────────────────────────────────────────────
// Lightweight logger that wraps console.error. Debug messages are gated
// behind the REV_DEBUG=1 env var so they don't pollute production output.
//
// For correlated logging across a single logical job (e.g. a walkthrough
// generation fiber that spans Effect, async iterators, and a Bun subprocess),
// wrap work with `withLogContext(ctx, fn)` — every `debug` / `logError` call
// inside that dynamic scope will prefix its output with key=value pairs. Uses
// Node's {@link AsyncLocalStorage} so it works across await points, Promise
// boundaries, and non-Effect callbacks without threading a context parameter.

import { AsyncLocalStorage } from 'node:async_hooks';
import { serverEnv } from './config';

const DEBUG = serverEnv.revDebug;

/** Key/value pairs prefixed on every log line inside the dynamic scope. */
export type LogContext = Readonly<Record<string, string | number | undefined>>;

const logContextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with `ctx` as the ambient logging context. Every `debug()` and
 * `logError()` call made synchronously or asynchronously from inside `fn`
 * will prefix its output with the context's key=value pairs. Nested calls
 * merge — the inner context wins for overlapping keys.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
	const parent = logContextStorage.getStore();
	const merged: LogContext = parent ? { ...parent, ...ctx } : ctx;
	return logContextStorage.run(merged, fn);
}

/**
 * Return the current ambient log context, or `undefined` if none is active.
 * Mostly useful for the logger internals; callers should prefer
 * {@link withLogContext} to establish context.
 */
export function getLogContext(): LogContext | undefined {
	return logContextStorage.getStore();
}

function formatContext(ctx: LogContext | undefined): string {
	if (!ctx) return '';
	const parts: string[] = [];
	for (const [k, v] of Object.entries(ctx)) {
		if (v === undefined) continue;
		parts.push(`${k}=${v}`);
	}
	return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** Log a debug message. Only emits output when REV_DEBUG=1. */
export function debug(tag: string, ...args: unknown[]): void {
	if (!DEBUG) return;
	const ctx = formatContext(logContextStorage.getStore());
	console.error(`[${tag}${ctx}]`, ...args);
}

/** Log an error message. Always emits output. */
export function logError(tag: string, ...args: unknown[]): void {
	const ctx = formatContext(logContextStorage.getStore());
	console.error(`[${tag}${ctx}]`, ...args);
}
