// Typed query client. Paths are same-origin in production (served by the
// collector) and proxied to the collector by Vite in dev.

import type {
  CategoryFacet,
  Kpis,
  OperationSummary,
  ServiceFacet,
  ServiceTimeseriesPoint,
  SpanRecord,
  TimeseriesPoint,
  TraceSummary,
} from "../../../src/shared/types";

export interface QueryArgs {
  windowMinutes: number;
  service?: string | undefined;
}

function qs(args: QueryArgs, extra?: Record<string, number>): string {
  const p = new URLSearchParams({ window: String(args.windowMinutes) });
  if (args.service && args.service !== "all") p.set("service", args.service);
  for (const [k, v] of Object.entries(extra ?? {})) p.set(k, String(v));
  return p.toString();
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  kpis: (a: QueryArgs) => get<Kpis>(`/api/kpis?${qs(a)}`),
  summary: (a: QueryArgs, includeNoise = false) =>
    get<OperationSummary[]>(`/api/summary?${qs(a)}${includeNoise ? "&includeNoise=1" : ""}`),
  categories: (windowMinutes: number) =>
    get<CategoryFacet[]>(
      `/api/categories?${new URLSearchParams({ window: String(windowMinutes) })}`,
    ),
  timeseries: (a: QueryArgs) => get<TimeseriesPoint[]>(`/api/timeseries?${qs(a)}`),
  serviceTimeseries: (a: QueryArgs) =>
    get<ServiceTimeseriesPoint[]>(`/api/timeseries/services?${qs(a)}`),
  slow: (a: QueryArgs, limit = 12) => get<SpanRecord[]>(`/api/slow?${qs(a, { limit })}`),
  errors: (a: QueryArgs, limit = 25) => get<SpanRecord[]>(`/api/errors?${qs(a, { limit })}`),
  traces: (a: QueryArgs, limit = 30) => get<TraceSummary[]>(`/api/traces?${qs(a, { limit })}`),
  trace: (id: string) => get<SpanRecord[]>(`/api/trace/${encodeURIComponent(id)}`),
  services: (windowMinutes: number) =>
    get<ServiceFacet[]>(`/api/services?${new URLSearchParams({ window: String(windowMinutes) })}`),
};
