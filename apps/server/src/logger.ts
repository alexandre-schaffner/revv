// ── Structured logging ──────────────────────────────────────────────────────
// Lightweight logger that wraps console.error. Debug messages are gated
// behind REVV_DEBUG=1 so they don't pollute production output.

import { serverEnv } from "./config";

const DEBUG = serverEnv.debug;

/** Log a debug message. Only emits output when REVV_DEBUG=1. */
export function debug(tag: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[${tag}]`, ...args);
}

/** Log an error message. Always emits output. */
export function logError(tag: string, ...args: unknown[]): void {
  console.error(`[${tag}]`, ...args);
}
