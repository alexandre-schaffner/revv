// Display formatting. Durations read in the unit that keeps 2–3 significant
// figures; counts get thin-space grouping; everything stays terse.

export function ms(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1) return "<1ms";
  if (value < 1000) return `${Math.round(value)}ms`;
  const s = value / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(2) : s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function count(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function tokens(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1000) return String(Math.round(value));
  return `${(value / 1000).toFixed(1)}k`;
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function decimal(value: number | null | undefined, digits = 1): string {
  if (value == null) return "—";
  return value.toFixed(digits);
}

/** Compact relative time: "12s ago", "4m ago". */
export function ago(epochMs: number, now: number): string {
  const d = Math.max(0, now - epochMs);
  if (d < 1000) return "now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}
