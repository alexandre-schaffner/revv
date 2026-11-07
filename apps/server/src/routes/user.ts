import { isMaintainerLogin, type UserIdentity } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { NotFoundError } from "../domain/errors";
import { GitHubAccounts } from "../services/github/accounts";
import { AvatarCache } from "../services/github/avatars";
import { requestAccount, runRoute, withAuth } from "./middleware";

export const userRoutes = new Elysia({ prefix: "/api/user" })
  .use(withAuth)
  /** The signed-in user, the GitHub account they act as on the active host, and its re-auth state. */
  .get("/identity", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const accounts = yield* GitHubAccounts;
        const profile = yield* accounts.userProfile(ctx.userId);
        if (!profile)
          return yield* Effect.fail(new NotFoundError({ resource: "user", id: ctx.userId }));
        const active = yield* requestAccount(ctx.userId, {}).pipe(
          Effect.catchTag("GitHubAuthError", () => Effect.succeed(null)),
        );
        const login = active?.githubLogin ?? null;
        const avatarContent =
          active && login
            ? ((yield* Effect.flatMap(AvatarCache, (a) => a.contents(active.host, [login]))).get(
                login,
              ) ?? null)
            : null;
        // Reconciles an `auth:reauth-required` push the client missed, and
        // clears the flag when the token works after all.
        const reauthRequired = active ? yield* accounts.probeFlagged(active.accountId) : false;
        return {
          id: profile.id,
          name: profile.name,
          email: profile.email,
          login,
          avatarContent,
          isMaintainer: isMaintainerLogin(login),
          reauthRequired,
          host: active?.host ?? null,
          onboardedAt: profile.onboardedAt?.toISOString() ?? null,
        } satisfies UserIdentity;
      }),
    ),
  )
  .delete("/account", (ctx) =>
    runRoute(
      Effect.flatMap(GitHubAccounts, (accounts) => accounts.removeUser(ctx.userId)).pipe(
        Effect.as({ deleted: true }),
      ),
    ),
  );
