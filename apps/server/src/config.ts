import { homedir } from "node:os";
import { join } from "node:path";
import { API_PORT, type AppChannel, DEFAULT_APP_CHANNEL } from "@revv/shared";
import { Config, Effect } from "effect";

/**
 * Server configuration schema resolved from environment variables via Effect's
 * `Config` module. Prefer consuming this inside `Effect.gen` blocks (services,
 * routes) — it keeps the dependency on env explicit and testable:
 *
 *     const { githubClientId } = yield* ServerConfig;
 *
 * For top-level module initialization that can't easily live inside Effect
 * (bare singletons like `auth.ts`, `db/index.ts`, `logger.ts`), use the
 * eagerly-resolved {@link serverEnv} snapshot instead.
 *
 * Authentication secrets are *not* handled here:
 *   • `GITHUB_CLIENT_SECRET` is no longer used — GitHub's device-code flow
 *     (the only auth path Revv exposes) does not require it.
 *   • `BETTER_AUTH_SECRET` is generated on first run and persisted to the
 *     per-user support directory (see {@link ./auth loadOrCreateAuthSecret}).
 *     The env var is still honored as an escape hatch for dev/CI.
 */
export const ServerConfig = Config.all({
  port: Config.integer("PORT").pipe(Config.withDefault(API_PORT)),
  channel: Config.string("REVV_CHANNEL").pipe(Config.withDefault(DEFAULT_APP_CHANNEL)),
  // SQLite location. Empty (the default) means "auto-resolve to the per-user
  // app-data dir" (`<appDataDir>/revv.db`) — the same durable tree as
  // `auth.key` and the secret store, so the DB survives app updates. The old
  // cwd-relative `./revv.db` default parked the file inside the launchd
  // WorkingDirectory / git checkout and orphaned it on every update, forcing a
  // full re-onboarding. `REVV_DB_PATH` overrides for dev/CI/self-hosting.
  // Resolution lives in `db/index.ts` (`resolveDbPath`) to avoid a config↔paths
  // import cycle.
  dbPath: Config.string("REVV_DB_PATH").pipe(Config.withDefault("")),
  // Build edition. `oss` (default) authenticates via the classic OAuth App
  // with the coarse `repo` scope, bring-your-own-credentials, for self-hosting.
  // `pro` authenticates via the Revv GitHub App (fine-grained permissions,
  // user-to-server tokens) on github.com. Device flow either way — no secret.
  // See docs/adr/0001-pro-github-app-oss-oauth-split.md.
  edition: Config.string("REVV_EDITION").pipe(Config.withDefault("oss")),
  // Generic GitHub Enterprise OAuth/App client_id override for dev or
  // self-hosting. No host is baked in — GHE users supply their own client_id
  // during onboarding (stored in settings, see `clientIdForHost`); this env
  // var is the escape hatch for a fixed self-hosted deployment. Empty by
  // default: a GHE host with neither a settings nor an env client_id fails
  // sign-in with a clear, diagnosable error rather than a wrong fallback.
  githubClientId: Config.string("GITHUB_CLIENT_ID").pipe(Config.withDefault("")),
  // Bundled OAuth App client_id, registered on github.com. The
  // `GITHUB_CLIENT_ID_PUBLIC` env var overrides for self-hosting.
  githubClientIdPublic: Config.string("GITHUB_CLIENT_ID_PUBLIC").pipe(
    Config.withDefault("Ov23liI36U1MLWk3kF8l"),
  ),
  // Bundled GitHub App client_id (Pro edition), registered on github.com.
  // Public value, not a secret — device flow needs no client_secret and the
  // app uses no private key on the client. Overridable via env.
  githubAppClientId: Config.string("GITHUB_APP_CLIENT_ID").pipe(
    Config.withDefault("Iv23lixUYaPwtByygekJ"),
  ),
  githubHost: Config.string("GITHUB_HOST").pipe(Config.withDefault("github.com")),
  revDebug: Config.boolean("REV_DEBUG").pipe(Config.withDefault(false)),
  // Absolute paths to the `claude` / `opencode` CLIs, resolved once by the
  // installer's shell (which has the user's full PATH including Homebrew,
  // asdf, mise, nix, etc.) and baked into the LaunchAgent plist's
  // EnvironmentVariables. Empty string = "not detected at install time" —
  // the server falls back to a runtime `which` lookup. See
  // apps/server/src/ai/providers/cli-agent.ts for the resolution chain.
  claudeBin: Config.string("REVV_CLAUDE_BIN").pipe(Config.withDefault("")),
  opencodeBin: Config.string("REVV_OPENCODE_BIN").pipe(Config.withDefault("")),
  codexBin: Config.string("REVV_CODEX_BIN").pipe(Config.withDefault("")),
  cloneDir: Config.string("REVV_CLONE_DIR").pipe(
    Config.withDefault(join(homedir(), ".revv", "repos")),
  ),
  // ── ACP (Agent Client Protocol) chat transport ──────────────────────────
  // The right-pane chat (and merge-conflict resolution) run on a single ACP
  // client adapter — the agent runs as a subprocess spoken to over stdio
  // JSON-RPC. Agent selection (see ai/acp/presets.ts): `acpAgent` picks any
  // registry agent by id (e.g. `cursor`) regardless of the legacy `aiAgent`
  // setting; `acpCommand`/`acpArgs` pin a raw command for an agent not in the
  // registry.
  acpAgent: Config.string("REVV_ACP_AGENT").pipe(Config.withDefault("")),
  acpCommand: Config.string("REVV_ACP_COMMAND").pipe(Config.withDefault("")),
  acpArgs: Config.string("REVV_ACP_ARGS").pipe(Config.withDefault("")),
});

export type ServerConfig = Config.Config.Success<typeof ServerConfig>;

/**
 * Eagerly-resolved snapshot of {@link ServerConfig} read once at module load.
 *
 * Use this for top-level singletons (auth, db, logger) that initialize at
 * import time and can't easily switch to Effect idioms. Code already living
 * inside an `Effect.gen` block should prefer `yield* ServerConfig` so the env
 * dependency stays explicit.
 */
const resolved = Effect.runSync(
  Effect.gen(function* () {
    return yield* ServerConfig;
  }),
);

function normalizeChannel(value: string): AppChannel {
  return value === "dev" ? "dev" : "prod";
}

function normalizeEdition(value: string): "oss" | "pro" {
  return value === "pro" ? "pro" : "oss";
}

/** `api.github.com` for github.com, `api.<host>` for GitHub Enterprise. */
const githubApiBase =
  resolved.githubHost === "github.com"
    ? "https://api.github.com"
    : `https://api.${resolved.githubHost}`;

export const serverEnv = {
  ...resolved,
  channel: normalizeChannel(resolved.channel),
  edition: normalizeEdition(resolved.edition),
  githubApiBase,
} as const;
