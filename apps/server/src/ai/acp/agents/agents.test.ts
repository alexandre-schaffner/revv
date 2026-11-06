import { describe, expect, it } from "bun:test";
import { ACP_AGENT_IDS } from "@revv/shared";
import { agentAdapter, agentLoginCommand } from ".";
import { claudeProcessEnv } from "./claude-code";
import { resolveDesktopCodexBin } from "./codex";

describe("model and effort routing", () => {
  it("passes Codex's model and reasoning effort through CODEX_CONFIG", () => {
    const route = agentAdapter("codex").route;
    expect(route({ model: "gpt-6-sol" })).toEqual({
      env: { CODEX_CONFIG: JSON.stringify({ model: "gpt-6-sol" }) },
    });
    expect(route({ model: "gpt-6-sol", thinkingEffort: "extra-high" }).env.CODEX_CONFIG).toBe(
      JSON.stringify({ model: "gpt-6-sol", model_reasoning_effort: "xhigh" }),
    );
    expect(route({ thinkingEffort: "max" }).env.CODEX_CONFIG).toBe(
      JSON.stringify({ model_reasoning_effort: "max" }),
    );
    expect(route({})).toEqual({ env: {} });
  });

  it("passes Ultra to eligible Codex models and clamps it for Luna and Claude", () => {
    const codex = agentAdapter("codex").route;
    const claude = agentAdapter("claude-code").route;
    expect(codex({ model: "gpt-6.1-sol", thinkingEffort: "ultra" }).env.CODEX_CONFIG).toBe(
      JSON.stringify({ model: "gpt-6.1-sol", model_reasoning_effort: "ultra" }),
    );
    expect(codex({ model: "gpt-6-luna", thinkingEffort: "ultra" }).env.CODEX_CONFIG).toBe(
      JSON.stringify({ model: "gpt-6-luna", model_reasoning_effort: "max" }),
    );
    expect(claude({ thinkingEffort: "ultra" }).env.CLAUDE_CODE_EFFORT_LEVEL).toBe("max");
    expect(
      claude({ model: "claude-haiku-4-5-20251001", thinkingEffort: "max" }).env,
    ).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
  });

  it("injects Claude Code model / effort via env", () => {
    const route = agentAdapter("claude-code").route;
    // No CLAUDE_CODE_DISABLE_1M_CONTEXT: 1M is Claude Code's own default when absent.
    expect(route({ model: "claude-opus-5-5", thinkingEffort: "high" })).toEqual({
      env: { ANTHROPIC_MODEL: "claude-opus-5-5", CLAUDE_CODE_EFFORT_LEVEL: "high" },
    });
    expect(route({ thinkingEffort: "extra-high" }).env.CLAUDE_CODE_EFFORT_LEVEL).toBe("xhigh");
    // A retired tier persisted before the ladder was trimmed → deepest real level.
    expect(route({ thinkingEffort: "ultrathink" }).env.CLAUDE_CODE_EFFORT_LEVEL).toBe("max");
    expect(route({ model: "claude-sonnet-5-5" }).sessionModel).toBeUndefined();
  });

  it("hands opencode the model at launch and per session", () => {
    // `opencode acp` rejects a `--model` flag. opencode 1 honors the inline
    // config override; opencode 2 ignores it and takes the per-session model.
    expect(agentAdapter("opencode").route({ model: "anthropic/claude-sonnet-4-6" })).toEqual({
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "anthropic/claude-sonnet-4-6" }) },
      sessionModel: "anthropic/claude-sonnet-4-6",
    });
  });
});

describe("claude-code process env", () => {
  it("gives every process the same config dir", () => {
    for (const purpose of ["acp", "status", "login"] as const) {
      expect(
        claudeProcessEnv({}, purpose, { subscriptionVerified: false, configDir: "/tmp/x" })
          .CLAUDE_CONFIG_DIR,
      ).toBe("/tmp/x");
    }
    expect(
      "CLAUDE_CONFIG_DIR" in claudeProcessEnv({}, "acp", { subscriptionVerified: false }),
    ).toBe(false);
  });

  it("strips stale Anthropic API credentials from the agent when the subscription is verified", () => {
    const env = claudeProcessEnv(
      {
        ANTHROPIC_API_KEY: "stale-api-key",
        ANTHROPIC_AUTH_TOKEN: "stale-bearer",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
        KEEP_ME: "yes",
      },
      "acp",
      { subscriptionVerified: true },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription-token");
    expect(env.KEEP_ME).toBe("yes");
  });

  it("keeps Anthropic API credentials without a verified subscription", () => {
    expect(
      claudeProcessEnv({ ANTHROPIC_API_KEY: "api-key" }, "acp", { subscriptionVerified: false })
        .ANTHROPIC_API_KEY,
    ).toBe("api-key");
  });

  it("never sets CLAUDE_CONFIG_DIR for another agent", () => {
    for (const id of ACP_AGENT_IDS) {
      if (id === "claude-code") continue;
      expect(agentAdapter(id).processEnv({ PATH: "/usr/bin" }, "acp")).toEqual({
        PATH: "/usr/bin",
      });
    }
  });
});

describe("claude-code agent telemetry", () => {
  const launch = (env: Record<string, string>) =>
    claudeProcessEnv(env, "acp", { subscriptionVerified: false });

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

  it("leaves telemetry off without a destination, and off the CLI's own processes", () => {
    expect(launch({}).CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    expect(
      claudeProcessEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:45680" }, "status", {
        subscriptionVerified: false,
      }).CLAUDE_CODE_ENABLE_TELEMETRY,
    ).toBeUndefined();
  });
});

describe("ACP auth method", () => {
  const methods = [{ id: "api-key" }, { id: "chat-gpt" }];

  it("prefers the ChatGPT session over an API key for Codex", () => {
    expect(agentAdapter("codex").authMethod(methods)).toBe("chat-gpt");
    expect(agentAdapter("codex").authMethod([{ id: "api-key" }])).toBe("api-key");
  });

  it("keeps the agent's advertised default for other providers", () => {
    expect(agentAdapter("claude-code").authMethod(methods)).toBe("api-key");
    expect(agentAdapter("opencode").authMethod([])).toBeUndefined();
  });
});

describe("login command", () => {
  it("uses Claude's subscription login path", () => {
    expect(agentLoginCommand("claude-code")?.slice(1)).toEqual(["auth", "login", "--claudeai"]);
  });

  it("is absent for an agent with nothing to sign in to", () => {
    expect(agentLoginCommand("opencode")).toBeNull();
  });
});

describe("resolveDesktopCodexBin", () => {
  it("uses the first executable bundled Codex CLI", () => {
    const first = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const second = "/Users/alex/Applications/ChatGPT.app/Contents/Resources/codex";
    expect(resolveDesktopCodexBin([first, second], (path) => path === second)).toBe(second);
  });

  it("does not return a desktop bundle path that is not executable", () => {
    expect(
      resolveDesktopCodexBin(["/Applications/ChatGPT.app/Contents/Resources/codex"], () => false),
    ).toBeNull();
  });
});
