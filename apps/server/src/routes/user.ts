import type { UserIdentity } from "@revv/shared";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { NotFoundError } from "../domain/errors";
import { forgetUser } from "../services/clone/forget";
import { GitHubAccounts } from "../services/github/accounts";
import { activeAccount, runRoute, withAuth } from "./middleware";

export const userRoutes = new Elysia({ prefix: "/api/user" })
  .use(withAuth)
  /**
   * The signed-in user and the host of the account they act as by default.
   * Each account's login, avatar and re-auth state is `/api/auth/accounts`.
   */
  .get("/identity", (ctx) =>
    runRoute(
      Effect.gen(function* () {
        const profile = yield* Effect.flatMap(GitHubAccounts, (a) => a.userProfile(ctx.userId));
        if (!profile)
          return yield* Effect.fail(new NotFoundError({ resource: "user", id: ctx.userId }));
        const active = yield* activeAccount(ctx.userId).pipe(
          Effect.catchTag("GitHubAuthError", () => Effect.succeed(null)),
        );
        return {
          id: profile.id,
          name: profile.name,
          email: profile.email,
          host: active?.host ?? null,
          onboardedAt: profile.onboardedAt?.toISOString() ?? null,
        } satisfies UserIdentity;
      }),
    ),
  )
  .delete("/account", (ctx) => runRoute(forgetUser(ctx.userId).pipe(Effect.as({ deleted: true }))));
