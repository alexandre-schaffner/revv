import type { Org, UserIdentity, UserRole } from "@revv/shared";
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { db } from "../auth";
import { account, repositories, user } from "../db/schema";
import { remoteUsers } from "../db/schema/remote-users";
import { AppRuntime } from "../runtime";
import { GitHubService } from "../services/GitHub";
import { PullRequestService } from "../services/PullRequest";
import { RemoteUserService } from "../services/RemoteUser";
import { SettingsService } from "../services/Settings";
import { TokenProvider } from "../services/TokenProvider";
import { handleAppError, withAuth } from "./middleware";

/**
 * Return the current user's GitHub identity and (optionally) their role for a PR.
 *
 * Role is `coder` when the user's GitHub login matches the PR author, otherwise
 * `reviewer`. Without a `prId` we return `unknown` — the frontend only needs role
 * info when rendering PR-scoped UI.
 *
 * If the stored `githubLogin` is missing (e.g. account predates the field), we
 * lazily backfill it from GitHub on first call.
 */
export const userRoutes = new Elysia({ prefix: "/api/user" })
  .use(withAuth)
  .get(
    "/identity",
    async (ctx) => {
      try {
        const userId = ctx.session.user.id;

        // Read current stored login + image (server-refreshed avatar URL).
        const rows = await db
          .select({
            githubLogin: user.githubLogin,
            image: user.image,
            identityId: user.identityId,
            onboardedAt: user.onboardedAt,
          })
          .from(user)
          .where(eq(user.id, userId));
        let login: string | null = rows[0]?.githubLogin ?? null;
        let avatarUrl: string | null = rows[0]?.image ?? null;
        const identityId = rows[0]?.identityId ?? null;
        const onboardedAt = rows[0]?.onboardedAt ?? null;

        // Backfill if missing — best-effort, don't fail the endpoint.
        // Also lazily refresh the avatar URL here so callers loading the
        // app get a fresh signed URL even if the poll scheduler hasn't
        // run yet this session.
        if (!login || !avatarUrl) {
          const backfilled = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const tokenProvider = yield* TokenProvider;
              const github = yield* GitHubService;
              const settingsService = yield* SettingsService;
              const settings = yield* settingsService
                .getSettings()
                .pipe(Effect.orElseSucceed(() => null));
              const host = settings?.githubHost?.trim() || undefined;
              const token = yield* tokenProvider.getGitHubToken(userId, host);
              const gh = yield* github.getAuthenticatedUserFresh(token);
              return gh;
            }).pipe(Effect.orElseSucceed(() => null)),
          );
          if (backfilled) {
            const updates: { githubLogin?: string; image?: string | null; updatedAt: Date } = {
              updatedAt: new Date(),
            };
            if (!login) updates.githubLogin = backfilled.login;
            if (!avatarUrl) updates.image = backfilled.avatarUrl;
            await db.update(user).set(updates).where(eq(user.id, userId));
            login = login ?? backfilled.login;
            avatarUrl = avatarUrl ?? backfilled.avatarUrl;
          }
        }

        // Ensure the user has a remote_users row and link it.
        let avatarContent: string | null = null;
        if (login) {
          const resolved = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const remoteUserService = yield* RemoteUserService;
              yield* remoteUserService.upsert({
                provider: "github",
                providerUserId: "", // Will be filled when we have the numeric ID
                login,
                avatarUrl,
              });
              return yield* remoteUserService.getAvatarContent(login);
            }).pipe(Effect.orElseSucceed(() => null)),
          );
          avatarContent = resolved;

          // Link the user to their remote_users identity if not already linked.
          if (!identityId && login) {
            const remoteUser = await db
              .select({ id: remoteUsers.id })
              .from(remoteUsers)
              .where(eq(remoteUsers.login, login))
              .get();
            if (remoteUser) {
              await db.update(user).set({ identityId: remoteUser.id }).where(eq(user.id, userId));
            }
          }
        }

        // Compute role if a PR is supplied
        let role: UserRole = "unknown";
        const prId = ctx.query.prId;
        if (prId && login) {
          const pr = await AppRuntime.runPromise(
            Effect.flatMap(PullRequestService, (s) => s.getPr(prId)).pipe(
              Effect.orElseSucceed(() => null),
            ),
          );
          if (pr) role = pr.authorLogin === login ? "coder" : "reviewer";
        }

        const identity: UserIdentity = { login, role, avatarContent };
        return {
          ...identity,
          onboardedAt: onboardedAt ? onboardedAt.toISOString() : null,
        };
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      query: t.Object({
        prId: t.Optional(t.String()),
      }),
    },
  )
  .get("/orgs", async (ctx) => {
    try {
      const userId = ctx.session.user.id;
      const orgs = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const tokenProvider = yield* TokenProvider;
          const github = yield* GitHubService;
          const settingsService = yield* SettingsService;
          const settings = yield* settingsService
            .getSettings()
            .pipe(Effect.orElseSucceed(() => null));
          const host = settings?.githubHost?.trim() || undefined;
          const token = yield* tokenProvider.getGitHubToken(userId, host);
          return yield* github.listUserOrgs(token);
        }).pipe(Effect.orElseSucceed(() => [] as Org[])),
      );
      return { orgs };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .delete("/account", async (ctx) => {
    try {
      const userId = ctx.session.user.id;
      // Delete only the repositories linked to this user's accounts.
      // pull_requests cascade from repositories, and review_sessions,
      // walkthroughs, chat_sessions cascade from pull_requests.
      const userAccounts = await db
        .select({ id: account.id })
        .from(account)
        .where(eq(account.userId, userId));
      const accountIds = userAccounts.map((a) => a.id);
      if (accountIds.length > 0) {
        await db.delete(repositories).where(inArray(repositories.accountId, accountIds));
      }
      // Deleting the user row cascades to session and account rows via FK onDelete: 'cascade'.
      // Repositories also cascade from account via FK onDelete: 'cascade',
      // so the explicit delete above is belt-and-suspenders.
      await db.delete(user).where(eq(user.id, userId));
      return { deleted: true };
    } catch (e) {
      return handleAppError(e, ctx);
    }
  });
