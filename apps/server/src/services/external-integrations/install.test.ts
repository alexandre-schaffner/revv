import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTERNAL_AGENT_PROVIDERS, type ExternalAgentProvider } from "@revv/shared";
import {
  type BridgeInstallInput,
  claudeCodePaths,
  codexPaths,
  cursorPaths,
  externalIntegrationInstaller,
  openCodePaths,
} from "./install";

const temporaryDirectories: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "revv-integration-test-"));
  temporaryDirectories.push(directory);
  // codexPaths honours CODEX_HOME; keep the real one out of the temp install.
  process.env.CODEX_HOME = join(directory, ".codex");
  return directory;
}

/** Minimal stand-in for the repository's `integrations/` directory. */
function assets(root: string): string {
  const directory = join(root, "integrations");
  mkdirSync(join(directory, "external-mcp-bridge"), { recursive: true });
  mkdirSync(join(directory, "external-agent-guides"), { recursive: true });
  mkdirSync(join(directory, "claude-code-plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(directory, "external-mcp-bridge", "revv-mcp.ts"), "#!/usr/bin/env bun\n");
  writeFileSync(
    join(directory, "external-agent-guides", "address-feedback.md"),
    "# Address Revv feedback\n\nCall get_review_context first.\n",
  );
  writeFileSync(
    join(directory, "claude-code-plugin", ".claude-plugin", "plugin.json"),
    '{"name":"revv"}\n',
  );
  return directory;
}

function input(root: string, token: string): BridgeInstallInput {
  return {
    runtimeExecutable: "/test/bun",
    token,
    apiUrl: "http://127.0.0.1:45678/mcp/external",
    integrationsDirectory: assets(root),
  };
}

/** Text of a location, reading the Claude plugin's `.mcp.json` for a directory. */
function credentialText(location: string): string {
  const file = statSync(location).isDirectory() ? join(location, ".mcp.json") : location;
  return readFileSync(file, "utf8");
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each([...EXTERNAL_AGENT_PROVIDERS])("%s install", (provider: ExternalAgentProvider) => {
  it("converges on reconnect and reports itself installed", () => {
    const home = temporaryHome();
    const installer = externalIntegrationInstaller(provider, home);

    expect(installer.installed()).toBe(false);
    installer.install(input(home, "first-token"));
    installer.install(input(home, "second-token"));

    expect(installer.installed()).toBe(true);
    const written = installer.locations.map(credentialText).join("\n");
    expect(written).toContain("second-token");
    expect(written).not.toContain("first-token");
  });

  it("removes everything it owns on disconnect", () => {
    const home = temporaryHome();
    const installer = externalIntegrationInstaller(provider, home);

    installer.install(input(home, "token"));
    installer.uninstall();

    expect(installer.installed()).toBe(false);
  });

  it("is a no-op when disconnecting something that was never connected", () => {
    const home = temporaryHome();
    const installer = externalIntegrationInstaller(provider, home);

    expect(() => {
      installer.uninstall();
    }).not.toThrow();
  });
});

describe("install safety", () => {
  it("refuses to replace a Claude Code plugin directory it does not own", () => {
    const home = temporaryHome();
    const { installDir } = claudeCodePaths(home);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "user-file"), "keep me\n");

    expect(() => {
      externalIntegrationInstaller("claude-code", home).install(input(home, "token"));
    }).toThrow("Refusing to replace");
    expect(existsSync(join(installDir, "user-file"))).toBe(true);
  });

  it("refuses a Codex config with a hand-written [mcp_servers.revv] section", () => {
    const home = temporaryHome();
    const paths = codexPaths(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(paths.configFile, '[mcp_servers.revv]\ncommand = "mine"\n');

    expect(() => {
      externalIntegrationInstaller("codex", home).install(input(home, "token"));
    }).toThrow("Revv did not create");
  });

  it("refuses a foreign mcpServers.revv entry in the Cursor config", () => {
    const home = temporaryHome();
    const paths = cursorPaths(home);
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify({ mcpServers: { revv: { command: "mine" } } }));

    expect(() => {
      externalIntegrationInstaller("cursor", home).install(input(home, "token"));
    }).toThrow("Revv did not create");
  });

  it("preserves unrelated Codex config and OpenCode MCP servers", () => {
    const home = temporaryHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      codexPaths(home).configFile,
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      openCodePaths(home).configFile,
      JSON.stringify({ model: "anthropic/claude", mcp: { other: { type: "local" } } }),
    );

    externalIntegrationInstaller("codex", home).install(input(home, "token"));
    externalIntegrationInstaller("opencode", home).install(input(home, "token"));
    externalIntegrationInstaller("codex", home).uninstall();
    externalIntegrationInstaller("opencode", home).uninstall();

    const codexConfig = readFileSync(codexPaths(home).configFile, "utf8");
    const openCodeConfig = JSON.parse(readFileSync(openCodePaths(home).configFile, "utf8")) as {
      model: string;
      mcp: Record<string, unknown>;
    };
    expect(codexConfig).toContain('model = "gpt-5"');
    expect(codexConfig).toContain("[mcp_servers.other]");
    expect(codexConfig).not.toContain("revv");
    expect(openCodeConfig.model).toBe("anthropic/claude");
    expect(Object.keys(openCodeConfig.mcp)).toEqual(["other"]);
  });

  it("writes the shared agent guide wherever a provider supports prompts", () => {
    const home = temporaryHome();
    externalIntegrationInstaller("codex", home).install(input(home, "token"));
    externalIntegrationInstaller("opencode", home).install(input(home, "token"));
    externalIntegrationInstaller("claude-code", home).install(input(home, "token"));

    const codexPrompt = readFileSync(codexPaths(home).promptFile, "utf8");
    const openCodeCommand = readFileSync(openCodePaths(home).commandFile, "utf8");
    const claudeSkill = readFileSync(
      join(claudeCodePaths(home).installDir, "skills", "address-feedback", "SKILL.md"),
      "utf8",
    );
    for (const document of [codexPrompt, openCodeCommand, claudeSkill]) {
      expect(document).toContain("Call get_review_context first.");
    }
    expect(openCodeCommand).toContain("description: Address Revv review feedback");
    expect(claudeSkill).toContain("description: Use when implementing");
  });
});
