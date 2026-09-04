// Central dashboard state. Owns the window/service selection, every query
// result, the live-connection status, and the re-query orchestration:
//   • SSE `perf:updated` → debounced refresh (bursty ingest coalesces)
//   • window/service change → immediate refresh
//   • a slow fallback poll so a dropped stream never strands the view
//
// Mirrors the main app's discipline: the stream is a signal; correctness comes
// from re-reading the REST snapshots.

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
import { api } from "./api";
import { subscribePerf } from "./sse";

export const WINDOW_OPTIONS = [
  { minutes: 15, label: "15m" },
  { minutes: 60, label: "1h" },
  { minutes: 360, label: "6h" },
] as const;

type Phase = "loading" | "ready" | "error";

const DEBOUNCE_MS = 500;
const FALLBACK_POLL_MS = 20_000;

class Dashboard {
  windowMinutes = $state(60);
  service = $state<string>("all");
  /** Show low-insight bookkeeping spans in the operations table. */
  showInternal = $state(false);

  phase = $state<Phase>("loading");
  error = $state<string | null>(null);
  /** True until the first successful load resolves (drives skeletons). */
  firstLoad = $state(true);

  kpis = $state<Kpis | null>(null);
  summary = $state<OperationSummary[]>([]);
  series = $state<TimeseriesPoint[]>([]);
  serviceSeries = $state<ServiceTimeseriesPoint[]>([]);
  slow = $state<SpanRecord[]>([]);
  errors = $state<SpanRecord[]>([]);
  traces = $state<TraceSummary[]>([]);
  services = $state<ServiceFacet[]>([]);
  categoryFacets = $state<CategoryFacet[]>([]);

  selectedTraceId = $state<string | null>(null);
  traceSpans = $state<SpanRecord[]>([]);
  traceLoading = $state(false);

  live = $state(false);
  lastEventMs = $state<number | null>(null);
  now = $state(Date.now());

  #debounce: ReturnType<typeof setTimeout> | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #clock: ReturnType<typeof setInterval> | null = null;
  #unsub: (() => void) | null = null;
  #reqSeq = 0;

  start(): void {
    void this.refresh();
    this.#unsub = subscribePerf({
      onUpdate: (d) => {
        this.lastEventMs = d.latestMs || Date.now();
        this.#scheduleRefresh();
      },
      onStatus: (connected) => {
        this.live = connected;
      },
    });
    this.#poll = setInterval(() => void this.refresh(), FALLBACK_POLL_MS);
    this.#clock = setInterval(() => {
      this.now = Date.now();
    }, 1000);
  }

  stop(): void {
    this.#unsub?.();
    if (this.#poll) clearInterval(this.#poll);
    if (this.#clock) clearInterval(this.#clock);
    if (this.#debounce) clearTimeout(this.#debounce);
  }

  setWindow(minutes: number): void {
    if (minutes === this.windowMinutes) return;
    this.windowMinutes = minutes;
    void this.refresh();
  }

  setService(service: string): void {
    if (service === this.service) return;
    this.service = service;
    void this.refresh();
  }

  setShowInternal(value: boolean): void {
    if (value === this.showInternal) return;
    this.showInternal = value;
    void this.refresh();
  }

  #scheduleRefresh(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
  }

  async refresh(): Promise<void> {
    const seq = ++this.#reqSeq;
    const args = { windowMinutes: this.windowMinutes, service: this.service };
    try {
      const [kpis, summary, series, serviceSeries, slow, errors, traces, services, categoryFacets] =
        await Promise.all([
          api.kpis(args),
          api.summary(args, this.showInternal),
          api.timeseries(args),
          api.serviceTimeseries(args),
          api.slow(args),
          api.errors(args),
          api.traces(args),
          api.services(this.windowMinutes),
          api.categories(this.windowMinutes),
        ]);
      if (seq !== this.#reqSeq) return; // a newer refresh superseded this one
      this.kpis = kpis;
      this.summary = summary;
      this.series = series;
      this.serviceSeries = serviceSeries;
      this.slow = slow;
      this.errors = errors;
      this.traces = traces;
      this.services = services;
      this.categoryFacets = categoryFacets;
      this.phase = "ready";
      this.error = null;
      this.firstLoad = false;
      // Keep the open waterfall in sync if its trace still exists.
      if (this.selectedTraceId) void this.#reloadTrace(this.selectedTraceId);
    } catch (err) {
      if (seq !== this.#reqSeq) return;
      this.phase = "error";
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  async selectTrace(id: string): Promise<void> {
    this.selectedTraceId = id;
    this.traceLoading = true;
    await this.#reloadTrace(id);
  }

  async #reloadTrace(id: string): Promise<void> {
    try {
      const spans = await api.trace(id);
      if (this.selectedTraceId === id) this.traceSpans = spans;
    } catch {
      if (this.selectedTraceId === id) this.traceSpans = [];
    } finally {
      if (this.selectedTraceId === id) this.traceLoading = false;
    }
  }

  closeTrace(): void {
    this.selectedTraceId = null;
    this.traceSpans = [];
  }

  get isEmpty(): boolean {
    return !this.firstLoad && (this.kpis?.spanCount ?? 0) === 0;
  }
}

export const dash = new Dashboard();
