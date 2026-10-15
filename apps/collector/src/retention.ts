const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Keep at least two weekly review windows by default, with a disk-use cap. */
export function retentionFromEnv(env: Readonly<Record<string, string | undefined>>): {
  maxAgeMs: number;
  maxRows: number;
} {
  return {
    maxAgeMs: positiveInteger(env.COLLECTOR_RETENTION_DAYS, 14) * DAY_MS,
    maxRows: positiveInteger(env.COLLECTOR_MAX_SPANS, 1_000_000),
  };
}
