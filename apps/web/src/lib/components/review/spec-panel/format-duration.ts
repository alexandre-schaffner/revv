/**
 * The ratings grid's elapsed readout, styled like Vitest/Jest output. Under
 * 10ms reads "0ms" so sub-tick noise doesn't jitter.
 */
export function formatDuration(ms: number): string {
  if (ms < 10) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
