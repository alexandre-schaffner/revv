import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACP_AGENTS, getAcpAgent } from "@revv/shared";
import { serverEnv } from "../../config";
import { ACP_LOGIN_COMMAND } from "../providers/cli-agent";
import {
  resolveAcpLaunchById,
  resolveAcpProcessLaunchById,
  resolveGenerationModel,
} from "./presets";

function withPathExecutable(command: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "revv-acp-preset-"));
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
      args: ["-y", "@agentclientprotocol/codex-acp"],
    });
  });

  it("passes the selected model to codex-acp through CODEX_CONFIG", () => {
    if (serverEnv.acpCommand) return;
    expect(resolveAcpLaunchById("codex", { model: "gpt-5.6-sol" })).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      env: { CODEX_CONFIG: JSON.stringify({ model: "gpt-5.6-sol" }) },
    });
  });

  it("injects model + reasoning effort as Codex session config", () => {
    if (serverEnv.acpCommand) return;
    expect(
      resolveAcpLaunchById("codex", { model: "gpt-5.6-sol", thinkingEffort: "extra-high" }),
    ).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      env: {
        CODEX_CONFIG: JSON.stringify({ model: "gpt-5.6-sol", model_reasoning_effort: "xhigh" }),
      },
    });
  });

  it("injects Claude Code model / context / effort via env", () => {
    if (serverEnv.acpCommand) return;
    const launch = resolveAcpLaunchById("claude-code", {
      model: "claude-opus-5",
      thinkingEffort: "high",
      contextWindow: "1m",
    });
    expect(launch.command).toBe("npx");
    expect(launch.env).toEqual({
      ANTHROPIC_MODEL: "claude-opus-5",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "false",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
    });
    // `extra-high` is Revv's key for Claude Code's `xhigh` level.
    expect(
      resolveAcpLaunchById("claude-code", { thinkingEffort: "extra-high" }).env
        ?.CLAUDE_CODE_EFFORT_LEVEL,
    ).toBe("xhigh");
    // Retired tier persisted before the ladder was trimmed → deepest real level.
    expect(
      resolveAcpLaunchById("claude-code", { thinkingEffort: "ultrathink" }).env
        ?.CLAUDE_CODE_EFFORT_LEVEL,
    ).toBe("max");
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

  it("keeps npx when the selected PATH provides it", () => {
    withPathExecutable("npx", (path) => {
      const launch = resolveAcpProcessLaunchById("claude-code", {}, {}, path, {
        claudeSubscriptionAuth: false,
      });

      expect(launch.command).toBe("npx");
      expect(launch.args).toEqual(["-y", "@agentclientprotocol/claude-agent-acp"]);
    });
  });

  it("falls back from npx to bunx and removes npx's yes flag", () => {
    withPathExecutable("bunx", (path) => {
      const launch = resolveAcpProcessLaunchById("claude-code", {}, {}, path, {
        claudeSubscriptionAuth: false,
      });

      expect(launch.command).toBe("bunx");
      expect(launch.args).toEqual(["@agentclientprotocol/claude-agent-acp"]);
    });
  });

  it("falls back from npx to bun x when only bun is available", () => {
    withPathExecutable("bun", (path) => {
      const launch = resolveAcpProcessLaunchById("codex", { model: "gpt-5.6-sol" }, {}, path);

      expect(launch.command).toBe("bun");
      expect(launch.args).toEqual(["x", "@agentclientprotocol/codex-acp"]);
      expect(launch.env.CODEX_CONFIG).toBe(JSON.stringify({ model: "gpt-5.6-sol" }));
    });
  });

  it("injects CLAUDE_CONFIG_DIR for claude-code when the option is set", () => {
    const launch = resolveAcpProcessLaunchById(
      "claude-code",
      { model: "claude-sonnet-4-6" },
      {},
      "/usr/bin",
      { claudeSubscriptionAuth: false, claudeConfigDir: "/tmp/x" },
    );

    expect(launch.env.CLAUDE_CONFIG_DIR).toBe("/tmp/x");
  });

  it("never leaks CLAUDE_CONFIG_DIR to a non-claude-code adapter", () => {
    if (serverEnv.acpCommand) return;
    const launch = resolveAcpProcessLaunchById("codex", { model: "gpt-5.6-sol" }, {}, "/usr/bin", {
      claudeConfigDir: "/tmp/x",
    });

    expect(launch.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("omits CLAUDE_CONFIG_DIR for claude-code when the option is absent", () => {
    const launch = resolveAcpProcessLaunchById(
      "claude-code",
      { model: "claude-sonnet-4-6" },
      {},
      "/usr/bin",
      { claudeSubscriptionAuth: false },
    );

    expect("CLAUDE_CONFIG_DIR" in launch.env).toBe(false);
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
    expect(resolveGenerationModel("claude-code", "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveGenerationModel("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
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
