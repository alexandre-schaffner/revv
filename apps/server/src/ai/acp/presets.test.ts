import { describe, expect, it } from "bun:test";
import { serverEnv } from "../../config";
import { ACP_AGENTS, resolveAcpLaunch } from "./presets";

describe("ACP agent registry", () => {
  it("is the single source of truth — adding an agent is one registry entry", () => {
    // `cursor` was added as a one-line entry; its id is part of the derived
    // `AcpAgentId` type and it resolves with no other code change.
    expect(ACP_AGENTS.cursor).toEqual({
      label: "Cursor",
      command: "npx",
      args: ["-y", "cursor-agent-acp"],
    });
    // Every registry entry has the minimal launch shape.
    for (const def of Object.values(ACP_AGENTS)) {
      expect(typeof def.command).toBe("string");
      expect(Array.isArray(def.args)).toBe(true);
    }
  });
});

describe("ACP launch presets", () => {
  it("launches the ACP adapter for the selected agent", () => {
    if (serverEnv.acpCommand) return;
    expect(resolveAcpLaunch("claude")).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    });
    expect(resolveAcpLaunch("opencode")).toEqual({
      command: "opencode",
      args: ["acp"],
    });
    expect(resolveAcpLaunch("codex")).toEqual({
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp"],
    });
  });

  it("passes the selected model to codex-acp at launch", () => {
    if (serverEnv.acpCommand) return;
    expect(resolveAcpLaunch("codex", "gpt-5.5")).toEqual({
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp", "-c", 'model="gpt-5.5"'],
    });
  });
});
