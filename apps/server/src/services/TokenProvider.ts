import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { serverEnv } from "../config";
import { account, user } from "../db/schema";
import { GitHubAuthError } from "../domain/errors";
import { DbService } from "./Db";

/**
 * Fetches the GitHub access token stored on the user's linked GitHub account.
 *
 * We read from the `account` table directly rather than going through
 * `better-auth`'s `getAccessToken` API because Revv's only auth path is the
 * device-code flow (see `routes/device-auth.ts`), which writes the token to
 * this table itself. Keeping the dependency local also means we don't need
 * better-auth's `socialProviders.github` to be configured — which it no
 * longer is, since `client_secret` was removed.
 */
export class TokenProvider extends Context.Tag("TokenProvider")<
  TokenProvider,
  {
    readonly getGitHubToken: (
      userId: string,
      host?: string,
    ) => Effect.Effect<string, GitHubAuthError>;
    /**
     * Resolve the active account row for a user + host. Returns the account
     * id, access token, and provider id so callers can scope DB queries by
     * `account_id` in addition to using the token.
     */
    readonly resolveAccount: (
      userId: string,
      host?: string,
    ) => Effect.Effect<
      { accountId: string; accessToken: string; providerId: string },
      GitHubAuthError
    >;
  }
>() {}

export const TokenProviderLive = Layer.effect(
  TokenProvider,
  Effect.gen(function* () {
    const { db } = yield* DbService;

    async function findAccount(userId: string, host?: string): Promise<
      { id: string; accessToken: string; providerId: string }
    > {
      // 'single-user' is a placeholder — resolve to the actual user ID
      let resolvedId = userId;
      if (userId === "single-user" || !userId) {
        const rows = await db.select({ id: user.id }).from(user).limit(1);
        const firstRow = rows[0];
        if (!firstRow) throw new Error("No user found");
        resolvedId = firstRow.id;
      }

      // Build ordered list of providerIds to try: specific host first, legacy fallback last.
      // Legacy 'github' rows exist for users who signed in before the host-keyed migration.
      const providerIds = host
        ? [`github:${host}`, "github"]
        : ["github:github.com", `github:${serverEnv.githubHost}`, "github"];

      const rows = await db
        .select({
          id: account.id,
          accessToken: account.accessToken,
          providerId: account.providerId,
        })
        .from(account)
        .where(eq(account.userId, resolvedId));

      for (const pid of providerIds) {
        const match = rows.find((r) => r.providerId === pid);
        if (match?.accessToken) {
          return match as { id: string; accessToken: string; providerId: string };
        }
      }

      throw new Error("No access token found");
    }

    return {
      getGitHubToken: (userId: string, host?: string) =>
        Effect.tryPromise({
          try: async () => {
            const match = await findAccount(userId, host);
            return match.accessToken;
          },
          catch: (e) => new GitHubAuthError({ message: String(e) }),
        }),

      resolveAccount: (userId: string, host?: string) =>
        Effect.tryPromise({
          try: async () => {
            const match = await findAccount(userId, host);
            return {
              accountId: match.id,
              accessToken: match.accessToken,
              providerId: match.providerId,
            };
          },
          catch: (e) => new GitHubAuthError({ message: String(e) }),
        }),
    };
  }),
);
