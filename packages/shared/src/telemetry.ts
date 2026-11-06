// The server's spans as the local telemetry collector reads them. The
// collector categorises spans and computes its KPIs by these names and keys,
// so both sides import them from here.

export const SPAN = {
  httpRequest: "http.request",
  walkthroughJob: "WalkthroughJobs.job",
  walkthroughGenerate: "WalkthroughJobs.generate",
  walkthroughEmitEvent: "WalkthroughJobs.emitEvent",
  walkthroughSetStatus: "WalkthroughJobs.setStatus",
  recapGenerate: "ProjectRecapJobs.generate",
} as const;

/** OpenTelemetry semantic-convention keys, plus Revv's own KPI keys. */
export const SPAN_ATTR = {
  httpMethod: "http.request.method",
  urlPath: "url.path",
  httpStatus: "http.response.status_code",
  toolCallCount: "tool_call_count",
  ttftMs: "ttft_ms",
} as const;
