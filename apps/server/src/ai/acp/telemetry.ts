import type { AcpAgentId } from "@revv/shared";

/** Claude's ACP adapter runs the Agent SDK, whose CLI exports its own spans.
 * Configure only traces: the local collector accepts OTLP/HTTP JSON, and has
 * no logs/metrics endpoints. Explicit caller settings always win. */
export function agentTelemetryEnv(
  agent: AcpAgentId,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (
    agent !== "claude-code" ||
    !(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT)
  ) {
    return {};
  }

  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: env.CLAUDE_CODE_ENABLE_TELEMETRY ?? "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA ?? "1",
    OTEL_TRACES_EXPORTER: env.OTEL_TRACES_EXPORTER ?? "otlp",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL:
      env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/json",
    OTEL_TRACES_EXPORT_INTERVAL: env.OTEL_TRACES_EXPORT_INTERVAL ?? "1000",
    OTEL_SERVICE_NAME: env.OTEL_SERVICE_NAME ?? "revv-agent-claude-code",
  };
}
