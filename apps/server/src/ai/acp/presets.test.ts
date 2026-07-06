import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ACP_AGENTS, getAcpAgent } from "@revv/shared";
import { serverEnv } from "../../config";
import { ACP_LOGIN_COMMAND } from "../providers/cli-agent";
import {
  agentCredentialsMissing,
  resolveAcpLaunchById,
  resolveAcpProcessLaunchById,
  resolveGenerationModel,
  setAgentCredentialCache,
  withAgentAuthHint,
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

  it("passes the selected model to opencode acp via --model", () => {
    if (serverEnv.acpCommand) return;
    expect(resolveAcpLaunchById("opencode", { model: "anthropic/claude-sonnet-4-6" })).toEqual({
      command: "opencode",
      args: ["acp", "--model", "anthropic/claude-sonnet-4-6"],
    });
  });
});

describe("ACP login commands", () => {
  it("uses Claude's subscription login path", () => {
    expect(ACP_LOGIN_COMMAND["claude-code"]).toEqual(["claude", "auth", "login", "--claudeai"]);
  });
});
// Injection and the missing-credential guard both read ambient env, so isolate
// every test in these blocks from the runner's real credentials and reset the
// module-level cache afterward (otherwise it would leak into the strict
// `toEqual` env test above).
function isolateAgentCredentials(): void {
  const saved: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };

  beforeEach(() => {
    for (const key of Object.keys(saved)) delete process.env[key];
    setAgentCredentialCache({});
  });

  afterEach(() => {
    setAgentCredentialCache({});
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("ACP agent credential injection", () => {
  isolateAgentCredentials();

  it("injects each agent's declared credential env var from the cache", () => {
    if (serverEnv.acpCommand) return;
    setAgentCredentialCache({
      "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" },
      codex: { OPENAI_API_KEY: "sk-openai-xyz" },
    });
    expect(resolveAcpLaunchById("claude-code").env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat01-abc",
    );
    expect(resolveAcpLaunchById("codex").env?.OPENAI_API_KEY).toBe("sk-openai-xyz");
  });

  it("skips injection only when the credential's OWN env var is already inherited", () => {
    if (serverEnv.acpCommand) return;
    // Own var present → don't double-inject (returned env holds only overrides).
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-inherited";
    process.env.OPENAI_API_KEY = "sk-openai-inherited";
    setAgentCredentialCache({
      "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" },
      codex: { OPENAI_API_KEY: "sk-openai-xyz" },
    });
    expect(resolveAcpLaunchById("claude-code").env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(resolveAcpLaunchById("codex").env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("still injects the stored token when only a hazard var (ANTHROPIC_API_KEY) is inherited", () => {
    if (serverEnv.acpCommand) return;
    // A stale ANTHROPIC_API_KEY must NOT suppress injection — it's a hazard that
    // buildAcpProcessEnv drops in favor of the token, not a substitute for it.
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-key";
    setAgentCredentialCache({ "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" } });
    expect(resolveAcpLaunchById("claude-code").env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat01-abc",
    );
  });

  it("only injects env vars the agent declares", () => {
    if (serverEnv.acpCommand) return;
    // opencode declares no credentials, so a stray cache entry is never injected.
    setAgentCredentialCache({ opencode: { SOMETHING: "x" } });
    expect(resolveAcpLaunchById("opencode").env).toBeUndefined();
  });

  it("drops a stale ANTHROPIC_API_KEY when injecting a stored subscription token", () => {
    if (serverEnv.acpCommand) return;
    // The crux fix: a stored token reaches the spawn env AND the inherited stale
    // key is dropped — without passing claudeSubscriptionAuth, since the injected
    // token is itself the subscription signal (the host probe can't see it).
    setAgentCredentialCache({ "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stored" } });
    const launch = resolveAcpProcessLaunchById(
      "claude-code",
      {},
      { ANTHROPIC_API_KEY: "stale-api-key", KEEP_ME: "yes" },
      "/usr/bin",
    );
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-stored");
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launch.env.KEEP_ME).toBe("yes");
  });
});

describe("ACP agent auth-failure hints", () => {
  isolateAgentCredentials();

  it("flags an agent as credential-less only when nothing is configured", () => {
    expect(agentCredentialsMissing("claude-code")).toBe(true);
    expect(agentCredentialsMissing("codex")).toBe(true);
    setAgentCredentialCache({ "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" } });
    expect(agentCredentialsMissing("claude-code")).toBe(false);
  });

  it("never flags agents that declare no credentials", () => {
    expect(agentCredentialsMissing("opencode")).toBe(false);
  });

  it("appends the connect hint to a credential-less agent's auth/connection error", () => {
    const out = withAgentAuthHint("claude-code", "ACP connection closed");
    expect(out).toContain("ACP connection closed");
    expect(out).toContain("Claude Code");
  });

  it("leaves errors for credential-free agents untouched", () => {
    expect(withAgentAuthHint("opencode", "boom")).toBe("boom");
  });

  it("does not append when creds are present and the error is unrelated", () => {
    setAgentCredentialCache({ "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" } });
    expect(withAgentAuthHint("claude-code", "some unrelated failure")).toBe(
      "some unrelated failure",
    );
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
