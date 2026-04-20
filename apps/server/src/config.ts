import { Config, Effect } from 'effect';

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
	port: Config.integer('PORT').pipe(Config.withDefault(45678)),
	dbPath: Config.string('REVV_DB_PATH').pipe(Config.withDefault('./revv.db')),
	// Bundled OAuth App client_id. `GITHUB_CLIENT_ID` env var overrides for
	// development, self-hosting, or GitHub Enterprise deployments.
	githubClientId: Config.string('GITHUB_CLIENT_ID').pipe(
		Config.withDefault('0v23g4GLrM59sDrek6wo'),
	),
	githubHost: Config.string('GITHUB_HOST').pipe(Config.withDefault('github.com')),
	revDebug: Config.boolean('REV_DEBUG').pipe(Config.withDefault(false)),
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

/** `api.github.com` for github.com, `api.<host>` for GitHub Enterprise. */
const githubApiBase =
	resolved.githubHost === 'github.com'
		? 'https://api.github.com'
		: `https://api.${resolved.githubHost}`;

export const serverEnv = {
	...resolved,
	githubApiBase,
} as const;

export type ServerEnv = typeof serverEnv;
