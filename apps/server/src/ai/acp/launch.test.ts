import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACP_AGENTS, getAcpAgent } from "@revv/shared";
import { serverEnv } from "../../config";
import { resolveAgentProcess } from "./launch";

function withPathExecutable(command: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "revv-acp-launch-"));
  try {
    const bin = join(dir, command);
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ACP agent registry", () => {
  it("gives every agent a launch, a CLI, and a catalog holding its default model", () => {
    expect(getAcpAgent("cursor")).toMatchObject({
      id: "cursor",
      command: "npx",
      args: ["-y", "cursor-agent-acp"],
      cli: { bin: "cursor-agent" },
    });
    for (const def of ACP_AGENTS) {
      expect(typeof def.command).toBe("string");
      expect(def.cli.install.length).toBeGreaterThan(0);
      if (def.capabilities.models !== "dynamic") {
        const values = def.capabilities.models.map((model) => model.value);
        expect(values).toContain(def.capabilities.defaultModel);
        expect(values).toContain(def.capabilities.suggestionsModel);
      }
    }
  });
});

describe("resolveAgentProcess", () => {
  it("keeps npx when the PATH provides it, layering the routed env over the given one", () => {
    if (serverEnv.acpCommand) return;
    withPathExecutable("npx", (path) => {
      const launch = resolveAgentProcess(
        "claude-code",
        { model: "claude-sonnet-5-5" },
        { PATH: path, KEEP_ME: "yes" },
      );
      expect(launch.command).toBe("npx");
      expect(launch.args).toEqual(["-y", "@agentclientprotocol/claude-agent-acp"]);
      expect(launch.viaPackageRunner).toBe(true);
      expect(launch.env).toMatchObject({
        KEEP_ME: "yes",
        ANTHROPIC_MODEL: "claude-sonnet-5-5",
        PATH: path,
      });
    });
  });

  it("falls back from npx to bunx and removes npx's yes flag", () => {
    if (serverEnv.acpCommand) return;
    withPathExecutable("bunx", (path) => {
      const launch = resolveAgentProcess("claude-code", {}, { PATH: path });
      expect(launch.command).toBe("bunx");
      expect(launch.args).toEqual(["@agentclientprotocol/claude-agent-acp"]);
      expect(launch.viaPackageRunner).toBe(true);
    });
  });

  it("falls back from npx to bun x when only bun is available", () => {
    if (serverEnv.acpCommand) return;
    withPathExecutable("bun", (path) => {
      const launch = resolveAgentProcess("codex", { model: "gpt-6-sol" }, { PATH: path });
      expect(launch.command).toBe("bun");
      expect(launch.args).toEqual(["x", "@agentclientprotocol/codex-acp"]);
      expect(launch.viaPackageRunner).toBe(true);
      expect(launch.env.CODEX_CONFIG).toBe(JSON.stringify({ model: "gpt-6-sol" }));
    });
  });

  it("runs an agent with its own binary outside the package runner", () => {
    if (serverEnv.acpCommand) return;
    const launch = resolveAgentProcess(
      "opencode",
      { model: "opencode/big-pickle" },
      { PATH: "/usr/bin" },
    );
    expect(launch.command.endsWith("opencode")).toBe(true);
    expect(launch.args).toEqual(["acp"]);
    expect(launch.viaPackageRunner).toBe(false);
    expect(launch.sessionModel).toBe("opencode/big-pickle");
  });
});
