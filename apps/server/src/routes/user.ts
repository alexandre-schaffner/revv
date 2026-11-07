import type { UserIdentity, UserRole } from "@revv/shared";
import { isMaintainerLogin, loginsMatch } from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { GitHubAccounts } from "../services/github/accounts";
import { AvatarCache } from "../services/github/avatars";
import { GitHubGateway } from "../services/github/gateway";
import { PullRequestService } from "../services/PullRequest";
import { SettingsService } from "../services/Settings";
import { runRoute, withAuth } from "./middleware";

/** The signed-in user's account on the active (settings) host, or null without one. */
const activeAccount = (userId: string) =>
  Effect.gen(function* () {
    const host = yield* Effect.flatMap(SettingsService, (s) => s.githubHost());
    const accounts = yield* GitHubAccounts;
    return yield* accounts
      .accountForUser(userId, host)
      .pipe(Effect.catchTag("GitHubAuthError", () => Effect.succeed(null)));
  });

export const userRoutes = new Elysia({ prefix: "/api/user" })
  .use(withAuth)
  /**
   * The signed-in user's GitHub identity, its re-auth state, and (with
   * `prId`) their role on that PR: `coder` when they wrote it.
   */
  .get(
    "/identity",
    (ctx) =>
      runRoute(
        Effect.gen(function* () {
          const userId = ctx.session.user.id;
          const accounts = yield* GitHubAccounts;
          const profile = yield* accounts.userProfile(userId);
          let login = profile?.githubLogin ?? null;
          let avatarUrl = profile?.image ?? null;
          const active = yield* activeAccount(userId);

          // Accounts that never got an avatar, or that predate the login
          // column (legacy-upgrade: userLoginBackfill).
          if (active && (!login || !avatarUrl)) {
            const github = yield* GitHubGateway;
            const viewer = yield* github.users
              .viewer(active.client)
              .pipe(Effect.orElseSucceed(() => null));
            if (viewer) {
              yield* accounts.backfillUserProfile(userId, {
                ...(login ? {} : { githubLogin: viewer.login }),
                ...(avatarUrl ? {} : { image: viewer.avatarUrl }),
              });
              login = login ?? viewer.login;
              avatarUrl = avatarUrl ?? viewer.avatarUrl;
            }
          }

          // The avatar is served from cached bytes. Refreshing them may fetch
          // from GitHub, so it runs detached: the next read gets the new bytes.
          let avatarContent: string | null = null;
          if (login) {
            const host =
              active?.host ?? (yield* Effect.flatMap(SettingsService, (s) => s.githubHost()));
            const avatars = yield* AvatarCache;
            yield* Effect.forkDetach(avatars.ensure(host, login, avatarUrl));
            avatarContent = (yield* avatars.contents(host, [login])).get(login) ?? null;
          }

          let role: UserRole = "unknown";
          const prId = ctx.query.prId;
          if (prId && login) {
            const pr = yield* Effect.flatMap(PullRequestService, (prs) => prs.getPr(prId)).pipe(
              Effect.catchTag("NotFoundError", () => Effect.succeed(null)),
            );
            if (pr) role = loginsMatch(pr.authorLogin, login) ? "coder" : "reviewer";
          }

          // Reconciles an `auth:reauth-required` push the client missed, and
          // clears the flag when the token works after all.
          const reauthRequired = active ? yield* accounts.probeFlagged(active.accountId) : false;

          const identity: UserIdentity = {
            login,
            role,
            avatarContent,
            isMaintainer: isMaintainerLogin(login),
            reauthRequired,
            host: active?.host ?? null,
          };
          return {
            ...identity,
            onboardedAt: profile?.onboardedAt ? profile.onboardedAt.toISOString() : null,
          };
        }),
      ),
    {
      query: t.Object({
        prId: t.Optional(t.String()),
      }),
    },
  )
  .delete("/account", (ctx) =>
    runRoute(
      Effect.flatMap(GitHubAccounts, (accounts) => accounts.removeUser(ctx.session.user.id)).pipe(
        Effect.as({ deleted: true }),
      ),
    ),
  );
