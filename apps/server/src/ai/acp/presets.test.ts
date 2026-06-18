import { describe, expect, it } from "bun:test";
import { ACP_AGENTS, getAcpAgent } from "@revv/shared";
import { serverEnv } from "../../config";
import { resolveAcpLaunchById, resolveGenerationModel } from "./presets";

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
      expect(def.capabilities.models === "dynamic" || Array.isArray(def.capabilities.models)).toBe(
        true,
      );
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

  it("passes the selected model to opencode acp via --model", () => {
    if (serverEnv.acpCommand) return;
    expect(resolveAcpLaunchById("opencode", { model: "anthropic/claude-sonnet-4-6" })).toEqual({
      command: "opencode",
      args: ["acp", "--model", "anthropic/claude-sonnet-4-6"],
    });
  });
});

describe("resolveGenerationModel", () => {
  it("keeps a model valid for the agent", () => {
    expect(resolveGenerationModel("claude-code", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveGenerationModel("codex", "gpt-5.5")).toBe("gpt-5.5");
  });

  it("falls back to the agent default when the model belongs to another agent", () => {
    // A Cursor model id left in the shared setting must not reach Claude Code.
    expect(resolveGenerationModel("claude-code", "sonnet-4.6")).toBe("claude-opus-4-8");
  });

  it("trusts opencode's dynamic catalog", () => {
    expect(resolveGenerationModel("opencode", "some-provider/some-model")).toBe(
      "some-provider/some-model",
    );
  });
});
