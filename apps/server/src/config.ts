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
 */
export const ServerConfig = Config.all({
	port: Config.integer('PORT').pipe(Config.withDefault(45678)),
	dbPath: Config.string('REVV_DB_PATH').pipe(Config.withDefault('./revv.db')),
	githubClientId: Config.string('GITHUB_CLIENT_ID').pipe(Config.withDefault('BUNDLED_CLIENT_ID')),
	githubClientSecret: Config.string('GITHUB_CLIENT_SECRET').pipe(
		Config.withDefault('BUNDLED_CLIENT_SECRET'),
	),
	githubHost: Config.string('GITHUB_HOST').pipe(Config.withDefault('github.com')),
	// Required — intentionally no default. Missing value aborts startup.
	betterAuthSecret: Config.string('BETTER_AUTH_SECRET').pipe(Config.withDefault('')),
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
 *
 * Throws with a human-friendly message if `BETTER_AUTH_SECRET` is absent —
 * matching the behavior the old inline `process.env` check provided.
 */
const resolved = Effect.runSync(
	Effect.gen(function* () {
		return yield* ServerConfig;
	}),
);

if (!resolved.betterAuthSecret) {
	throw new Error(
		'BETTER_AUTH_SECRET environment variable is required. Generate one with: openssl rand -hex 32',
	);
}

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
