import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PORT, type ExternalAgentProvider } from "@revv/shared";
import { Effect, Layer } from "effect";
import { serverEnv } from "../config";
import { createDb, type Db } from "../db/index";
import { account, externalIntegrations, user } from "../db/schema";
import { DbService } from "./Db";
import {
  ExternalIntegrations,
  externalIntegrationsLayer,
  isIntegrationCredentialActive,
  selectPullRequestForCheckout,
} from "./ExternalIntegrations";
import {
  externalIntegrationInstaller,
  findIntegrationsDirectory,
} from "./external-integrations/install";

describe("isIntegrationCredentialActive", () => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");

  it("requires an unrevoked future expiry", () => {
    expect(
      isIntegrationCredentialActive(
        { revokedAt: null, expiresAt: "2026-09-23T12:00:00.000Z" },
        now,
      ),
    ).toBe(true);
    expect(
      isIntegrationCredentialActive(
        { revokedAt: null, expiresAt: "2026-09-21T12:00:00.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      isIntegrationCredentialActive(
        {
          revokedAt: "2026-09-22T11:00:00.000Z",
          expiresAt: "2026-09-23T12:00:00.000Z",
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("selectPullRequestForCheckout", () => {
  const pullRequests = [
    { id: "older", headSha: "a".repeat(40), sourceBranch: "feature" },
    { id: "newer", headSha: "b".repeat(40), sourceBranch: "feature-two" },
  ];

  it("prefers the nearest reviewed head in the checkout ancestry", () => {
    const selected = selectPullRequestForCheckout(
      pullRequests,
      ["c".repeat(40), "b".repeat(40), "a".repeat(40)],
      null,
    );
    expect(selected?.id).toBe("newer");
  });

  it("uses an unambiguous branch only when no head matches", () => {
    const selected = selectPullRequestForCheckout(pullRequests, ["c".repeat(40)], "feature");
    expect(selected?.id).toBe("older");
  });

  it("does not guess when a branch matches more than one pull request", () => {
    const selected = selectPullRequestForCheckout(
      [...pullRequests, { id: "duplicate", headSha: "d".repeat(40), sourceBranch: "feature" }],
      ["c".repeat(40)],
      "feature",
    );
    expect(selected).toBeNull();
  });

  it("ignores pull requests whose head is unknown", () => {
    const selected = selectPullRequestForCheckout(
      [{ id: "unsynced", headSha: null, sourceBranch: "feature" }],
      ["a".repeat(40)],
      null,
    );
    expect(selected).toBeNull();
  });
});

describe("installs on a shared credential", () => {
  const ACCOUNT_ID = "account-1";
  const TOKEN = "revv_cc_token";
  const THIS_SERVER = `http://${serverEnv.host}:${serverEnv.port}/mcp/external`;
  const OTHER_SERVER = `http://127.0.0.1:${serverEnv.port + 1}/mcp/external`;
  const directories: string[] = [];
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function scratchHome(): string {
    const home = mkdtempSync(join(tmpdir(), "revv-external-integrations-"));
    directories.push(home);
    process.env.CODEX_HOME = join(home, ".codex");
    return home;
  }

  const currentBridge = () =>
    readFileSync(join(findIntegrationsDirectory(), "external-mcp-bridge", "revv-mcp.ts"), "utf8");

  function seededDb(provider: ExternalAgentProvider): Db {
    const db = createDb(":memory:");
    const now = new Date();
    db.insert(user)
      .values({ id: "user-1", name: "U", email: "u@example.com", createdAt: now, updatedAt: now })
      .run();
    db.insert(account)
      .values({
        id: ACCOUNT_ID,
        accountId: "gh-1",
        providerId: "github:github.com",
        userId: "user-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(externalIntegrations)
      .values({
        id: "integration-1",
        provider,
        userId: "user-1",
        accountId: ACCOUNT_ID,
        tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
        scopes: "[]",
        createdAt: now.toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .run();
    return db;
  }

  /** Install as the server at `apiUrl` did, with a bridge older than the bundled one. */
  function installedBy(home: string, provider: ExternalAgentProvider, apiUrl: string) {
    const installer = externalIntegrationInstaller(provider, ACCOUNT_ID, home);
    const stale = join(home, "stale-assets");
    mkdirSync(join(stale, "external-mcp-bridge"), { recursive: true });
    mkdirSync(join(stale, "external-agent-guides"), { recursive: true });
    mkdirSync(join(stale, "claude-code-plugin", ".claude-plugin"), { recursive: true });
    writeFileSync(join(stale, "external-mcp-bridge", "revv-mcp.ts"), "// old bridge\n");
    writeFileSync(join(stale, "external-agent-guides", "address-feedback.md"), "# Guide\n");
    writeFileSync(join(stale, "claude-code-plugin", ".claude-plugin", "plugin.json"), "{}\n");
    installer.install({
      runtimeExecutable: "/test/bun",
      token: TOKEN,
      integrationsDirectory: stale,
      apiUrl,
    });
    return installer;
  }

  function bridgeCopy(home: string): string {
    const [copy] = [...new Bun.Glob("**/server/revv-mcp.ts").scanSync({ cwd: home, dot: true })];
    return readFileSync(join(home, copy ?? ""), "utf8");
  }

  const run = <A, E>(
    db: Db,
    home: string,
    use: (service: typeof ExternalIntegrations.Service) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.flatMap(ExternalIntegrations, use).pipe(
        Effect.provide(
          externalIntegrationsLayer(home).pipe(Layer.provide(Layer.succeed(DbService, { db }))),
        ),
      ),
    );

  it.each(["claude-code", "codex", "opencode", "cursor"] as const)(
    "%s: the boot refresh rewrites this server's install",
    async (provider) => {
      const home = scratchHome();
      const installer = installedBy(home, provider, THIS_SERVER);

      await run(seededDb(provider), home, (service) => service.refreshInstalls());

      expect(bridgeCopy(home)).toBe(currentBridge());
      expect(installer.installedBinding()).toEqual({ token: TOKEN, apiUrl: THIS_SERVER });
    },
  );

  it.each(["claude-code", "codex", "opencode", "cursor"] as const)(
    "%s: a server on a copy of the database leaves another server's install alone",
    async (provider) => {
      const home = scratchHome();
      const installer = installedBy(home, provider, OTHER_SERVER);
      const db = seededDb(provider);

      await run(db, home, (service) => service.refreshInstalls());
      expect(bridgeCopy(home)).toBe("// old bridge\n");
      expect(installer.installedBinding()).toEqual({ token: TOKEN, apiUrl: OTHER_SERVER });

      await run(db, home, (service) => service.uninstallAccount(ACCOUNT_ID));
      await run(db, home, (service) => service.disconnect(ACCOUNT_ID, provider));
      expect(installer.installed()).toBe(true);
    },
  );

  it.if(serverEnv.host === "127.0.0.1" && serverEnv.port === API_PORT)(
    "pins an install written before the bridge carried a server URL",
    async () => {
      const home = scratchHome();
      const installer = installedBy(home, "claude-code", THIS_SERVER);
      const config = join(home, ".claude", "skills");
      const [mcpJson] = [...new Bun.Glob("*/.mcp.json").scanSync({ cwd: config, dot: true })];
      const file = join(config, mcpJson ?? "");
      writeFileSync(file, readFileSync(file, "utf8").replace(/"REVV_API_URL": "[^"]*",?/, ""));
      expect(installer.installedBinding()).toEqual({ token: TOKEN, apiUrl: null });

      await run(seededDb("claude-code"), home, (service) => service.refreshInstalls());

      expect(installer.installedBinding()).toEqual({ token: TOKEN, apiUrl: THIS_SERVER });
    },
  );

  it.each(["claude-code", "codex", "opencode", "cursor"] as const)(
    "%s: forgetting the account removes this server's install",
    async (provider) => {
      const home = scratchHome();
      const installer = installedBy(home, provider, THIS_SERVER);

      await run(seededDb(provider), home, (service) => service.uninstallAccount(ACCOUNT_ID));

      expect(installer.installed()).toBe(false);
    },
  );
});
