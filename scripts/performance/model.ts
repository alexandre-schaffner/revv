import type { OperationSummary } from "../../apps/collector/src/shared/types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error("Expected a JSON object");
  }
  return value;
}

export function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Expected a finite, nonnegative number");
  }
  return value;
}

export function summaries(value: unknown): OperationSummary[] {
  if (!Array.isArray(value)) throw new Error("Expected operation summaries");
  return value.map((item: unknown) => {
    const row = object(item);
    const result = {
      name: text(row.name),
      serviceName: text(row.serviceName),
      category: text(row.category),
      count: number(row.count),
      p50: number(row.p50),
      p95: number(row.p95),
      max: number(row.max),
      avgMs: number(row.avgMs),
      errorCount: number(row.errorCount),
      errorRate: number(row.errorRate),
    };
    if (
      !Number.isInteger(result.count) ||
      result.errorCount > result.count ||
      result.errorRate > 1
    ) {
      throw new Error("Invalid operation counts or error rate");
    }
    return result;
  });
}

// The service is part of an operation's identity. Span-time can overlap across
// parents, children and concurrent requests; it is never a CPU-time estimate.
export function rankCandidates(current: OperationSummary[], previous: OperationSummary[]) {
  const key = (row: OperationSummary) => JSON.stringify([row.serviceName, row.name]);
  const prior = new Map(previous.map((row) => [key(row), row]));
  return current
    .filter((row) => row.count >= 5 && row.p95 >= 25)
    .map((row) => {
      const baseline = prior.get(key(row));
      const comparable = baseline !== undefined && baseline.count >= 5 && baseline.p95 > 0;
      return {
        ...row,
        aggregateSpanMs: row.count * row.avgMs,
        previousCount: baseline?.count ?? 0,
        p95ChangePercent: comparable ? (row.p95 / baseline.p95 - 1) * 100 : null,
        reason:
          comparable && row.p95 > baseline.p95 * 1.2 ? "tail-latency-increase" : "span-time-demand",
      };
    })
    .sort((a, b) => b.aggregateSpanMs - a.aggregateSpanMs)
    .slice(0, 20);
}

export interface Measurement {
  version: 1;
  workload: string;
  fixtureHash: string;
  outputHash: string;
  batch: number;
  warmups: number;
  profiled: boolean;
  runtime: string;
  machine: string;
  samplesMs: number[];
}

export function measurement(value: unknown): Measurement {
  const row = object(value);
  if (row.version !== 1 || typeof row.profiled !== "boolean" || !Array.isArray(row.samplesMs)) {
    throw new Error("Unsupported benchmark artifact");
  }
  const samplesMs = row.samplesMs.map(number);
  if (samplesMs.some((value) => value <= 0) || samplesMs.length < 15) {
    throw new Error("Need at least 15 positive timing samples");
  }
  const batch = number(row.batch);
  const warmups = number(row.warmups);
  if (!Number.isInteger(batch) || batch < 1 || !Number.isInteger(warmups) || warmups < 3) {
    throw new Error("Invalid batch size or insufficient warmup");
  }
  return {
    version: 1,
    workload: text(row.workload),
    fixtureHash: text(row.fixtureHash),
    outputHash: text(row.outputHash),
    batch,
    warmups,
    profiled: row.profiled,
    runtime: text(row.runtime),
    machine: text(row.machine),
    samplesMs,
  };
}

export function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

export function compare(before: Measurement, after: Measurement) {
  const identity = [
    "workload",
    "fixtureHash",
    "outputHash",
    "batch",
    "warmups",
    "runtime",
    "machine",
  ] as const;
  for (const field of identity) {
    if (before[field] !== after[field])
      throw new Error(`Incomparable benchmarks: ${field} differs`);
  }
  if (before.profiled || after.profiled)
    throw new Error("Use unprofiled captures for timing comparisons");
  if (before.samplesMs.length !== after.samplesMs.length) throw new Error("Sample counts differ");
  const stats = (samples: number[]) => {
    const medianMs = quantile(samples, 0.5);
    return {
      medianMs,
      p95Ms: quantile(samples, 0.95),
      relativeMad:
        quantile(
          samples.map((value) => Math.abs(value - medianMs)),
          0.5,
        ) / medianMs,
    };
  };
  const baseline = stats(before.samplesMs);
  const candidate = stats(after.samplesMs);
  const gainPercent = (1 - candidate.medianMs / baseline.medianMs) * 100;
  const noisy = baseline.relativeMad > 0.1 || candidate.relativeMad > 0.1;
  const separated = quantile(after.samplesMs, 0.75) < quantile(before.samplesMs, 0.25);
  const verdict = noisy
    ? "inconclusive"
    : gainPercent <= -10 || candidate.p95Ms > baseline.p95Ms * 1.1
      ? "regressed"
      : gainPercent >= 10 && separated && candidate.p95Ms <= baseline.p95Ms * 1.05
        ? "improved"
        : "inconclusive";
  return {
    verdict,
    gainPercent,
    baseline,
    candidate,
    noisy,
    interpretation: "A local benchmark signal, not proof of an end-to-end user improvement.",
  };
}
