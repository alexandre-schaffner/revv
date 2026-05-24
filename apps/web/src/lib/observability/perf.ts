// ── Perf helpers ────────────────────────────────────────────────────────────
//
// One pattern for sync timing (`traced` or its scope-handle twin `startSpan`),
// one for async (`tracedAsync`), one for $effect/$derived bodies. All four
// land in the same ring buffer + histograms so `__revv.spansByName()` covers
// every call site uniformly.

import { recordCounter, recordHistogram } from "./metrics";
import { recordSpan } from "./tracer";

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/** End-of-span recorder shared between the callback and scope-handle forms. */
function finish(name: string, start: number, attrs: Record<string, unknown>, error: unknown): void {
  const duration = now() - start;
  recordSpan(name, start, duration, attrs, error);
  recordHistogram(`${name}.duration`, attrs, duration);
  if (error != null) recordCounter(`${name}.errors`, attrs);
}

/** Synchronous span via callback. Returns `fn`'s value, re-throws on error. */
export function traced<T>(name: string, attrs: Record<string, unknown>, fn: () => T): T {
  const start = now();
  let error: unknown = null;
  try {
    return fn();
  } catch (e) {
    error = e;
    throw e;
  } finally {
    finish(name, start, attrs, error);
  }
}

/** Async span. Same shape as `traced`. */
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
    finish(name, start, attrs, error);
  }
}

/**
 * Async span with a final-attrs hook so the recorder can stamp values only
 * known at completion (e.g. HTTP status). Avoids the open-coded fetch wrapper
 * pattern.
 */
export async function tracedAsyncWith<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<{ value: T; attrs?: Record<string, unknown> }>,
): Promise<T> {
  const start = now();
  let extra: Record<string, unknown> | undefined;
  let error: unknown = null;
  try {
    const out = await fn();
    extra = out.attrs;
    return out.value;
  } catch (e) {
    error = e;
    throw e;
  } finally {
    finish(name, start, extra ? { ...attrs, ...extra } : attrs, error);
  }
}

export interface SpanHandle {
  /** Record the span. `error` becomes the error-counter trigger if non-null. */
  end(error?: unknown): void;
  /** Add or override attributes before `end()` (e.g. status known mid-span). */
  setAttrs(extra: Record<string, unknown>): void;
}

/**
 * Scope-handle equivalent of {@link traced}. Use when a closure boundary would
 * break TS narrowing (e.g. the walkthrough reducer's `newBlocks` mutation
 * across a `switch` body inside a `for` loop), or when the end of the span
 * doesn't line up with the end of a function.
 */
export function startSpan(name: string, attrs: Record<string, unknown>): SpanHandle {
  const start = now();
  let current = attrs;
  let ended = false;
  return {
    setAttrs(extra) {
      current = { ...current, ...extra };
    },
    end(error?: unknown) {
      if (ended) return;
      ended = true;
      finish(name, start, current, error ?? null);
    },
  };
}

/**
 * Body wrapper for a Svelte 5 `$effect(...)`. Must be *called from inside*
 * the effect — `tracedEffect` is not a replacement for `$effect` itself
 * (runes are compiler-magic and can't be wrapped by a generic helper).
 *
 *   $effect(() => tracedEffect("layout.url-sync", () => { ... }));
 */
export function tracedEffect<T>(name: string, fn: () => T): T {
  return traced(`effect.${name}`, {}, fn);
}

/**
 * Body wrapper for `$derived.by(...)`. Same caveat as {@link tracedEffect}.
 *
 *   const x = $derived.by(() => tracedDerived("walkthrough.active", () => ...));
 */
export function tracedDerived<T>(name: string, fn: () => T): T {
  return traced(`derived.${name}`, {}, fn);
}

export { logger } from "./logger";
export { recordCounter, recordHistogram } from "./metrics";
