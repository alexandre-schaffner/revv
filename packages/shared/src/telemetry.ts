// The server's spans as the local telemetry collector reads them. The
// collector categorises spans and computes its KPIs by these names and keys,
// so both sides import them from here.

export const SPAN = {
  httpRequest: "http.request",
  walkthroughGenerate: "WalkthroughJobs.generate",
  walkthroughEmitEvent: "WalkthroughJobs.emitEvent",
  recapGenerate: "ProjectRecapJobs.generate",
} as const;

/** Span-name namespaces (`<prefix>.<operation>`); the collector categorises spans by them. */
export const SPAN_NAMESPACE = {
  github: "GitHub",
  agentTool: "Agent",
  mcp: "Mcp",
  ai: "Ai",
  chat: "Chat",
  acp: "Acp",
  walkthrough: "Walkthrough",
  recapJobs: "ProjectRecapJobs",
  repoClone: "RepoClone",
} as const;

export type SpanNamespace = keyof typeof SPAN_NAMESPACE;

/** `<prefix>.<operation>`: a span name the collector files under `ns`'s category. */
export function spanName<N extends SpanNamespace, O extends string>(
  ns: N,
  operation: O,
): `${(typeof SPAN_NAMESPACE)[N]}.${O}` {
  return `${SPAN_NAMESPACE[ns]}.${operation}`;
}

/** OpenTelemetry semantic-convention keys, plus Revv's own KPI keys. */
export const SPAN_ATTR = {
  httpMethod: "http.request.method",
  urlPath: "url.path",
  httpStatus: "http.response.status_code",
  toolCallCount: "tool_call_count",
  ttftMs: "ttft_ms",
  walkthroughId: "walkthrough_id",
  recapId: "recapId",
  briefId: "briefId",
  prId: "prId",
  /** A `WalkthroughStartTrigger`. */
  trigger: "trigger",
  model: "model",
  provider: "provider",
} as const;
