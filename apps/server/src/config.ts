import { homedir } from "node:os";
import { join } from "node:path";
import { API_PORT, type AppChannel, DEFAULT_APP_CHANNEL } from "@revv/shared";
import { Config, Effect } from "effect";

// The only module that reads Revv's environment. Everything else reads
// `serverEnv`. Third-party tool variables (PATH, SHELL, CODEX_HOME, provider
// API keys) are read where a child process's environment is assembled, since
// they describe what that tool will see, not how Revv is configured.
const EnvConfig = Config.all({
  desktopPid: Config.Int("REVV_DESKTOP_PID").pipe(Config.withDefault(0)),
  port: Config.Int("PORT").pipe(Config.withDefault(API_PORT)),
  // Bind interface. Loopback-only by default so the API is unreachable off-box.
  // `REVV_HOST` is the escape hatch for self-hosting; a non-loopback value also
  // disables the loopback request guard (an explicit opt-in to off-box exposure).
  host: Config.String("REVV_HOST").pipe(Config.withDefault("127.0.0.1")),
  channel: Config.String("REVV_CHANNEL").pipe(Config.withDefault(DEFAULT_APP_CHANNEL)),
  // SQLite location. Empty (the default) resolves to `<appDataDir>/revv.db`
  // (`resolveDbPath` in `db/index.ts`), beside `auth.key` and the secret store,
  // so the DB survives app updates. `REVV_DB_PATH` overrides for
  // dev/CI/self-hosting.
  dbPath: Config.String("REVV_DB_PATH").pipe(Config.withDefault("")),
  // Build edition. `oss` (default) authenticates via the classic OAuth App
  // with the coarse `repo` scope, bring-your-own-credentials, for self-hosting.
  // `pro` authenticates via the Revv GitHub App (fine-grained permissions,
  // user-to-server tokens) on github.com. Device flow either way — no secret.
  // See docs/adr/0001-pro-github-app-oss-oauth-split.md.
  edition: Config.String("REVV_EDITION").pipe(Config.withDefault("oss")),
  // Generic GitHub Enterprise OAuth/App client_id override for dev or
  // self-hosting. No host is baked in — GHE users supply their own client_id
  // during onboarding (stored in settings, see `clientIdForHost`); this env
  // var is the escape hatch for a fixed self-hosted deployment. Empty by
  // default: a GHE host with neither a settings nor an env client_id fails
  // sign-in with a clear, diagnosable error rather than a wrong fallback.
  githubClientId: Config.String("GITHUB_CLIENT_ID").pipe(Config.withDefault("")),
  // Bundled OAuth App client_id, registered on github.com. The
  // `GITHUB_CLIENT_ID_PUBLIC` env var overrides for self-hosting.
  githubClientIdPublic: Config.String("GITHUB_CLIENT_ID_PUBLIC").pipe(
    Config.withDefault("Ov23liI36U1MLWk3kF8l"),
  ),
  // Bundled GitHub App client_id (Pro edition), registered on github.com.
  // Public value, not a secret — device flow needs no client_secret and the
  // app uses no private key on the client. Overridable via env.
  githubAppClientId: Config.String("GITHUB_APP_CLIENT_ID").pipe(
    Config.withDefault("Iv23lixUYaPwtByygekJ"),
  ),
  githubHost: Config.String("GITHUB_HOST").pipe(Config.withDefault("github.com")),
  // `REV_DEBUG` is the older spelling, still set by existing `.env` files.
  debug: Config.Boolean("REVV_DEBUG").pipe(
    Config.orElse(() => Config.Boolean("REV_DEBUG")),
    Config.withDefault(false),
  ),
  // Keys the encrypted-file token store (`SecretStore`) when the OS keyring is
  // unavailable; otherwise a key is generated on first run under the app-data
  // dir. The name is from when better-auth signed sessions with it: renaming it
  // would make existing fallback stores unreadable.
  secretStoreSecret: Config.String("BETTER_AUTH_SECRET").pipe(Config.withDefault("")),
  // `0` disables, `1` writes beside the DB, any other value is a file path.
  // Empty means "on in the dev channel only".
  githubLedger: Config.String("REVV_GITHUB_LEDGER").pipe(Config.withDefault("")),
  pyroscopeEndpoint: Config.String("REVV_PYROSCOPE_ENDPOINT").pipe(Config.withDefault("")),
  integrationsDir: Config.String("REVV_INTEGRATIONS_DIR").pipe(Config.withDefault("")),
  // A fake-gcs-server endpoint for the team cache. Deliberately not
  // STORAGE_EMULATOR_HOST: with that set, `@google-cloud/storage` forces
  // bare-bucket URLs that the emulator doesn't serve.
  cacheApiEndpoint: Config.String("REVV_CACHE_API_ENDPOINT").pipe(Config.withDefault("")),
  // Pre-DB installs kept settings in this JSON file (see `upgrades.ts`).
  legacySettingsPath: Config.String("REVV_SETTINGS_PATH").pipe(
    Config.withDefault(join(homedir(), ".revv", "settings.json")),
  ),
  // Set by a package manager that owns the install (the Nix Home Manager
  // module sets "nix"). Non-empty turns the in-app updater into a no-op:
  // `/api/update-manifest` answers 204 so the desktop app never swaps a
  // bundle out from under the manager that pinned it.
  updatesManagedBy: Config.String("REVV_UPDATES_MANAGED_BY").pipe(Config.withDefault("")),
  // Absolute paths to the `claude` / `opencode` / `codex` CLIs, resolved once by
  // the installer's shell (which has the user's full PATH including Homebrew,
  // asdf, mise, nix, etc.) and saved in desktop-server.json's environment.
  // Empty = "not detected at install time": the server falls back to a runtime
  // lookup (each adapter in `ai/acp/agents/`).
  claudeBin: Config.String("REVV_CLAUDE_BIN").pipe(Config.withDefault("")),
  opencodeBin: Config.String("REVV_OPENCODE_BIN").pipe(Config.withDefault("")),
  codexBin: Config.String("REVV_CODEX_BIN").pipe(Config.withDefault("")),
  cloneDir: Config.String("REVV_CLONE_DIR").pipe(
    Config.withDefault(join(homedir(), ".revv", "repos")),
  ),
  // Isolated `CLAUDE_CONFIG_DIR` for claude-code ACP agents
  // (`ai/acp/agents/claude-config.ts`). Keeps Revv's sessions out of
  // `~/.claude`, whose `projects` registry VS Code's Copilot Chat extension
  // force-opens as git repos — polluting the Source Control view with every PR
  // worktree Revv spawns an agent in.
  claudeConfigDir: Config.String("REVV_CLAUDE_CONFIG_DIR").pipe(
    Config.withDefault(join(homedir(), ".revv", "claude")),
  ),
  // Escape hatch for the isolation above — set to `false` to have claude-code
  // ACP agents fall back to the shared `~/.claude` (e.g. to inspect a session
  // with the bare `claude` CLI, or while troubleshooting).
  claudeConfigIsolation: Config.Boolean("REVV_CLAUDE_CONFIG_ISOLATION").pipe(
    Config.withDefault(true),
  ),
  // ACP testing knobs: `acpAgent` overrides the persisted agent with any
  // registry agent id (e.g. `cursor`); `acpCommand`/`acpArgs` pin a raw adapter
  // command, for an agent not in the registry (see `ai/acp/launch.ts`).
  acpAgent: Config.String("REVV_ACP_AGENT").pipe(Config.withDefault("")),
  acpCommand: Config.String("REVV_ACP_COMMAND").pipe(Config.withDefault("")),
  acpArgs: Config.String("REVV_ACP_ARGS").pipe(Config.withDefault("")),
  otlpEndpoint: Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.withDefault("")),
  // Dev-only fallback; the OS keyring (`SecretStore`, `secret:jev-api-key`)
  // wins when both are set. Never returned by unauthenticated `GET /api/settings`.
  jevApiKey: Config.String("REVV_JEV_API_KEY").pipe(Config.withDefault("")),
});

const resolved = Effect.runSync(
  Effect.gen(function* () {
    return yield* EnvConfig;
  }),
);

function normalizeChannel(value: string): AppChannel {
  return value === "dev" ? "dev" : "prod";
}

function normalizeEdition(value: string): "oss" | "pro" {
  return value === "pro" ? "pro" : "oss";
}

const trimmed = (value: string) => value.trim();

export const serverEnv = {
  ...resolved,
  channel: normalizeChannel(resolved.channel),
  edition: normalizeEdition(resolved.edition),
  githubLedger: trimmed(resolved.githubLedger),
  integrationsDir: trimmed(resolved.integrationsDir),
  cacheApiEndpoint: trimmed(resolved.cacheApiEndpoint),
} as const;
