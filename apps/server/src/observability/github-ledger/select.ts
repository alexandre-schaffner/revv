import type { GitHubCall } from "./record";

export interface Selection {
  readonly since?: string | null;
  readonly origin?: string | null;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

export function sinceMs(since: string, now = Date.now()): number | null {
  const relative = since.trim().match(/^(\d+(?:\.\d+)?)([smh]?)$/);
  if (relative) return now - Number(relative[1]) * (UNITS[relative[2] || "s"] ?? 1000);
  const absolute = Date.parse(since);
  return Number.isNaN(absolute) ? null : absolute;
}

export function selectCalls(calls: readonly GitHubCall[], selection: Selection): GitHubCall[] {
  const from = selection.since ? sinceMs(selection.since) : null;
  const origin = selection.origin?.toLowerCase() ?? null;
  return calls.filter(
    (c) =>
      (from === null || c.start >= from) &&
      (origin === null || c.origin.label.toLowerCase().includes(origin)),
  );
}
