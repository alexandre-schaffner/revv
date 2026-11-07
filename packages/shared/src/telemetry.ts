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
