import { Config } from 'effect';

export const ServerConfig = Config.all({
	port: Config.integer('PORT').pipe(Config.withDefault(45678)),
	dbPath: Config.string('REVV_DB_PATH').pipe(Config.withDefault('./revv.db')),
	githubClientId: Config.string('GITHUB_CLIENT_ID').pipe(Config.withDefault('BUNDLED_CLIENT_ID')),
	githubClientSecret: Config.string('GITHUB_CLIENT_SECRET').pipe(
		Config.withDefault('BUNDLED_CLIENT_SECRET')
	),
});

export type ServerConfig = Config.Config.Success<typeof ServerConfig>;
