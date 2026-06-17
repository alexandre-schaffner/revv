import { describe, expect, it } from "bun:test";
import { serverEnv } from "../../config";
import { resolveAcpLaunch } from "./presets";

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
