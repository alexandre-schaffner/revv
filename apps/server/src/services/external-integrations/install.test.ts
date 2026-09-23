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
  externalIntegrationAccountKey,
  externalIntegrationInstaller,
  openCodePaths,
} from "./install";

const temporaryDirectories: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const ACCOUNT_ID = "account-1";
const ACCOUNT_KEY = externalIntegrationAccountKey(ACCOUNT_ID);

function installer(provider: ExternalAgentProvider, home: string) {
  return externalIntegrationInstaller(provider, ACCOUNT_ID, home);
}

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
    const integrationInstaller = installer(provider, home);

    expect(integrationInstaller.installed()).toBe(false);
    integrationInstaller.install(input(home, "first-token"));
    integrationInstaller.install(input(home, "second-token"));

    expect(integrationInstaller.installed()).toBe(true);
    const written = integrationInstaller.locations.map(credentialText).join("\n");
    expect(written).toContain("second-token");
    expect(written).not.toContain("first-token");
  });

  it("removes everything it owns on disconnect", () => {
    const home = temporaryHome();
    const integrationInstaller = installer(provider, home);

    integrationInstaller.install(input(home, "token"));
    integrationInstaller.uninstall();

    expect(integrationInstaller.installed()).toBe(false);
  });

  it("is a no-op when disconnecting something that was never connected", () => {
    const home = temporaryHome();
    const integrationInstaller = installer(provider, home);

    expect(() => {
      integrationInstaller.uninstall();
    }).not.toThrow();
  });
});

describe("install safety", () => {
  it("refuses to replace a Claude Code plugin directory it does not own", () => {
    const home = temporaryHome();
    const { installDir } = claudeCodePaths(ACCOUNT_KEY, home);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "user-file"), "keep me\n");

    expect(() => {
      installer("claude-code", home).install(input(home, "token"));
    }).toThrow("Refusing to replace");
    expect(existsSync(join(installDir, "user-file"))).toBe(true);
  });

  it("refuses a Codex config with a hand-written account-scoped section", () => {
    const home = temporaryHome();
    const paths = codexPaths(ACCOUNT_KEY, home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(paths.configFile, `[mcp_servers.revv-${ACCOUNT_KEY}]\ncommand = "mine"\n`);

    expect(() => {
      installer("codex", home).install(input(home, "token"));
    }).toThrow("Revv did not create");
  });

  it("refuses a foreign account-scoped entry in the Cursor config", () => {
    const home = temporaryHome();
    const paths = cursorPaths(ACCOUNT_KEY, home);
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      paths.configFile,
      JSON.stringify({ mcpServers: { [`revv-${ACCOUNT_KEY}`]: { command: "mine" } } }),
    );

    expect(() => {
      installer("cursor", home).install(input(home, "token"));
    }).toThrow("Revv did not create");
  });

  it("preserves unrelated Codex config and OpenCode MCP servers", () => {
    const home = temporaryHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      codexPaths(ACCOUNT_KEY, home).configFile,
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      openCodePaths(ACCOUNT_KEY, home).configFile,
      JSON.stringify({ model: "anthropic/claude", mcp: { other: { type: "local" } } }),
    );

    installer("codex", home).install(input(home, "token"));
    installer("opencode", home).install(input(home, "token"));
    installer("codex", home).uninstall();
    installer("opencode", home).uninstall();

    const codexConfig = readFileSync(codexPaths(ACCOUNT_KEY, home).configFile, "utf8");
    const openCodeConfig = JSON.parse(
      readFileSync(openCodePaths(ACCOUNT_KEY, home).configFile, "utf8"),
    ) as {
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
    installer("codex", home).install(input(home, "token"));
    installer("opencode", home).install(input(home, "token"));
    installer("claude-code", home).install(input(home, "token"));

    const codexPrompt = readFileSync(codexPaths(ACCOUNT_KEY, home).promptFile, "utf8");
    const openCodeCommand = readFileSync(openCodePaths(ACCOUNT_KEY, home).commandFile, "utf8");
    const claudeSkill = readFileSync(
      join(claudeCodePaths(ACCOUNT_KEY, home).installDir, "skills", "address-feedback", "SKILL.md"),
      "utf8",
    );
    for (const document of [codexPrompt, openCodeCommand, claudeSkill]) {
      expect(document).toContain("Call get_review_context first.");
    }
    expect(openCodeCommand).toContain("description: Address Revv review feedback");
    expect(claudeSkill).toContain("description: Use when implementing");
  });

  it("keeps two accounts isolated and disconnects only the selected account", () => {
    const home = temporaryHome();
    const first = externalIntegrationInstaller("cursor", "account-a", home);
    const second = externalIntegrationInstaller("cursor", "account-b", home);

    first.install(input(home, "token-a"));
    second.install(input(home, "token-b"));
    first.uninstall();

    const config = readFileSync(
      cursorPaths(externalIntegrationAccountKey("account-b"), home).configFile,
      "utf8",
    );
    expect(config).not.toContain("token-a");
    expect(config).toContain("token-b");
    expect(first.installed()).toBe(false);
    expect(second.installed()).toBe(true);
  });

  it("tightens permissions when replacing a pre-existing config", () => {
    const home = temporaryHome();
    const configFile = cursorPaths(ACCOUNT_KEY, home).configFile;
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(configFile, "{}\n", { mode: 0o644 });

    installer("cursor", home).install(input(home, "token"));

    expect(statSync(configFile).mode & 0o777).toBe(0o600);
  });
});
