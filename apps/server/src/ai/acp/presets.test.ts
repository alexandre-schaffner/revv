import { describe, expect, it } from "bun:test";
import { ACP_AGENTS, getAcpAgent } from "@revv/shared";
import { serverEnv } from "../../config";
import { ACP_LOGIN_COMMAND } from "../providers/cli-agent";
import {
  resolveAcpLaunchById,
  resolveAcpProcessLaunchById,
  resolveGenerationModel,
} from "./presets";

describe("ACP agent registry", () => {
  it("is the single source of truth — adding an agent is one registry entry", () => {
    // `cursor` was added as a one-line entry; its id is part of the derived
    // `AcpAgentId` type and it resolves with no other code change.
    expect(getAcpAgent("cursor")).toMatchObject({
      id: "cursor",
      label: "Cursor",
      icon: "cursor",
      command: "npx",
      args: ["-y", "cursor-agent-acp"],
    });
    // Every registry entry has the minimal launch shape + a capability surface.
    for (const def of ACP_AGENTS) {
      expect(typeof def.command).toBe("string");
      expect(Array.isArray(def.args)).toBe(true);
      expect(def.capabilities).toBeDefined();
      expect(typeof def.capabilities.defaultModel).toBe("string");
      expect(def.capabilities.models === "dynamic" || Array.isArray(def.capabilities.models)).toBe(
        true,
      );
      if (def.capabilities.models !== "dynamic") {
        expect(
          def.capabilities.models.some((model) => model.value === def.capabilities.defaultModel),
        ).toBe(true);
      }
    }
  });
});

describe("ACP launch presets", () => {
  it("launches the right adapter for each registry agent id", () => {
    if (serverEnv.acpCommand) return;
    expect(resolveAcpLaunchById("claude-code")).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    });
    expect(resolveAcpLaunchById("opencode")).toEqual({
      command: "opencode",
      args: ["acp"],
    });
    expect(resolveAcpLaunchById("codex")).toEqual({
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp"],
    });
  });

  it("passes the selected model to codex-acp at launch", () => {
    if (serverEnv.acpCommand) return;
    expect(resolveAcpLaunchById("codex", { model: "gpt-5.5" })).toEqual({
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp", "-c", 'model="gpt-5.5"'],
    });
  });

  it("injects model + reasoning effort as codex `-c` args", () => {
    if (serverEnv.acpCommand) return;
    expect(
      resolveAcpLaunchById("codex", { model: "gpt-5.5", thinkingEffort: "extra-high" }),
    ).toEqual({
      command: "npx",
      args: [
        "-y",
        "@zed-industries/codex-acp",
        "-c",
        'model="gpt-5.5"',
        "-c",
        'model_reasoning_effort="xhigh"',
      ],
    });
  });

  it("injects Claude Code model / context / thinking via env", () => {
    if (serverEnv.acpCommand) return;
    const launch = resolveAcpLaunchById("claude-code", {
      model: "claude-opus-4-8",
      thinkingEffort: "high",
      contextWindow: "1m",
    });
    expect(launch.command).toBe("npx");
    expect(launch.env).toEqual({
      ANTHROPIC_MODEL: "claude-opus-4-8",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "false",
      MAX_THINKING_TOKENS: "24000",
    });
    // The 200K tier disables the 1M context.
    expect(
      resolveAcpLaunchById("claude-code", { contextWindow: "200k" }).env
        ?.CLAUDE_CODE_DISABLE_1M_CONTEXT,
    ).toBe("true");
  });

  it("strips stale Anthropic API credentials when Claude subscription auth exists", () => {
    const launch = resolveAcpProcessLaunchById(
      "claude-code",
      { model: "claude-sonnet-4-6" },
      {
        ANTHROPIC_API_KEY: "stale-api-key",
        ANTHROPIC_AUTH_TOKEN: "stale-bearer",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
        KEEP_ME: "yes",
      },
      "/usr/bin",
      { claudeSubscriptionAuth: true },
    );

    expect(launch.command).toBe("npx");
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription-token");
    expect(launch.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(launch.env.KEEP_ME).toBe("yes");
    expect(launch.env.PATH).toBe("/usr/bin");
  });

  it("keeps Anthropic API credentials when no Claude subscription auth exists", () => {
    const launch = resolveAcpProcessLaunchById(
      "claude-code",
      {},
      { ANTHROPIC_API_KEY: "api-key" },
      "/usr/bin",
      { claudeSubscriptionAuth: false },
    );

    expect(launch.env.ANTHROPIC_API_KEY).toBe("api-key");
  });

  it("injects the selected model into opencode acp via OPENCODE_CONFIG_CONTENT", () => {
    if (serverEnv.acpCommand) return;
    // `opencode acp` rejects a `--model` flag, so the model rides in as an inline
    // config override the ACP subcommand honors.
    expect(resolveAcpLaunchById("opencode", { model: "anthropic/claude-sonnet-4-6" })).toEqual({
      command: "opencode",
      args: ["acp"],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "anthropic/claude-sonnet-4-6" }) },
    });
  });
});

describe("ACP login commands", () => {
  it("uses Claude's subscription login path", () => {
    expect(ACP_LOGIN_COMMAND["claude-code"]).toEqual(["claude", "auth", "login", "--claudeai"]);
  });
});

describe("resolveGenerationModel", () => {
  it("keeps a model valid for the agent", () => {
    expect(resolveGenerationModel("claude-code", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveGenerationModel("codex", "gpt-5.5")).toBe("gpt-5.5");
  });

  it("falls back to the agent default when the model belongs to another agent", () => {
    // A Cursor model id left in the shared setting must not reach Claude Code.
    expect(resolveGenerationModel("claude-code", "sonnet-4.6")).toBe("claude-sonnet-5");
  });

  it("trusts opencode's dynamic catalog", () => {
    expect(resolveGenerationModel("opencode", "some-provider/some-model")).toBe(
      "some-provider/some-model",
    );
    expect(resolveGenerationModel("opencode", null)).toBe("opencode/big-pickle");
  });
});
