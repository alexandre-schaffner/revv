import { describe, expect, it } from "bun:test";
import { resolveAcpProcessLaunchById } from "./presets";

describe("ACP native telemetry", () => {
  const launch = (env: Record<string, string>, agent: "claude-code" | "codex" = "claude-code") =>
    resolveAcpProcessLaunchById(agent, {}, env, "/usr/bin", { claudeSubscriptionAuth: false }).env;

  it("exports Claude model/tool spans to the configured collector using JSON", () => {
    expect(launch({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:45680" })).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:45680",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_SERVICE_NAME: "revv-agent-claude-code",
    });
  });

  it("preserves opt-outs, credentials, custom destinations, protocols and content settings", () => {
    const env = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer test",
      OTEL_SERVICE_NAME: "custom-agent",
      OTEL_LOG_USER_PROMPTS: "0",
    };
    expect(launch(env)).toMatchObject(env);
    expect(launch(env).OTEL_EXPORTER_OTLP_TRACES_PROTOCOL).toBe("http/protobuf");
  });

  it("leaves telemetry off without a destination and does not configure other agents", () => {
    expect(launch({}).CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    expect(
      launch({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:45680" }, "codex")
        .CLAUDE_CODE_ENABLE_TELEMETRY,
    ).toBeUndefined();
  });
});
