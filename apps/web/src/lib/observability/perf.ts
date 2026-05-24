// ── Perf helpers ────────────────────────────────────────────────────────────
//
// The only thing the rest of the codebase imports for instrumentation. Two
// shapes:
//
//   • `traced(name, attrs, fn)` — synchronous wrapper for hot, sync code
//     (the SSE event reducers, WS message dispatcher branches). Pure JS
//     under the hood — pays `performance.now()` × 2 + a ring-buffer push
//     and one histogram update. No Effect involvement on the hot path.
//
//   • `tracedAsync(name, attrs, fn)` — for fetch / API / SSE handlers.
//     Same JS recorder; the only difference is awaiting the promise and
//     stamping the error before re-throwing.

import { recordCounter, recordHistogram } from "./metrics";
import { recordSpan } from "./tracer";

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/** Synchronous span. Returns `fn`'s value, re-throws on error after recording. */
export function traced<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: () => T,
): T {
  const start = now();
  let error: unknown = null;
  try {
    return fn();
  } catch (e) {
    error = e;
    throw e;
  } finally {
    const duration = now() - start;
    recordSpan(name, start, duration, attrs, error);
    recordHistogram(`${name}.duration`, attrs, duration);
    if (error) recordCounter(`${name}.errors`, attrs);
  }
}

/** Async span. Same shape, awaits and records on settle. */
export async function tracedAsync<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = now();
  let error: unknown = null;
  try {
    return await fn();
  } catch (e) {
    error = e;
    throw e;
  } finally {
    const duration = now() - start;
    recordSpan(name, start, duration, attrs, error);
    recordHistogram(`${name}.duration`, attrs, duration);
    if (error) recordCounter(`${name}.errors`, attrs);
  }
}

export { recordCounter, recordHistogram } from "./metrics";
export { logger } from "./logger";
