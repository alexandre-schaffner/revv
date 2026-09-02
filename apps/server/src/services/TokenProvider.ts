import { eq } from "drizzle-orm";
import { Context, Deferred, Effect, Layer, Ref } from "effect";
import { serverEnv } from "../config";
import { account, user } from "../db/schema";
import { userSettings } from "../db/schema/user-settings";
import { GitHubAuthError } from "../domain/errors";
import { clientIdForHost, tokenUrlForHost } from "../github-oauth";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";
import { SecretStore, type TokenPair } from "./SecretStore";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
}

/**
 * Fetches and maintains the GitHub access token for a user's linked account.
 *
 * Token *bytes* live in {@link SecretStore} (the OS secure element); the
 * `account` row holds only non-secret metadata (provider/host, expiry
 * timestamps, `reauthRequiredAt`). We read the `account` table directly rather
 * than via better-auth because Revv's only auth path is the device-code flow
 * (see `routes/device-auth.ts`), which now also captures a refresh token when
 * the OAuth App issues one.
 *
 * The provider transparently refreshes a near-expiry access token on read, and
 * exposes `refreshAccountToken` / `markReauthRequired` for the reactive 401
 * recovery path driven by `PollScheduler`.
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
      { accountId: string; accessToken: string; providerId: string; githubLogin: string | null },
      GitHubAuthError
    >;
    /**
     * Look up an account's access token by its primary key. Used by
     * background jobs (e.g. PollScheduler) that already know which account
     * owns a given resource and must avoid the "first user / first matching
     * providerId" fallback path — that path is correct for interactive
     * single-user contexts but wrong as soon as multiple users or multiple
     * accounts per host are present on the machine.
     */
    readonly getTokenByAccountId: (accountId: string) => Effect.Effect<string, GitHubAuthError>;
    /**
     * Persist freshly issued token material for an account and notify clients
     * that any re-auth gate for this account can be cleared.
     */
    readonly storeAccountTokens: (
      accountId: string,
      host: string,
      tokens: TokenPair,
    ) => Effect.Effect<void>;
    /** Delete token material for a locally disconnected account. */
    readonly deleteAccountTokens: (accountId: string) => Effect.Effect<void>;
    /**
     * Exchange the account's stored refresh token for a fresh access token,
     * persisting both to the secure store and clearing `reauthRequiredAt`.
     * Fails with `GitHubAuthError` when no usable refresh token exists or
     * GitHub rejects the grant — the caller then routes to
     * `markReauthRequired`.
     */
    readonly refreshAccountToken: (accountId: string) => Effect.Effect<string, GitHubAuthError>;
    /**
     * Clear a persisted re-auth gate after the account has either received new
     * token material or proven its existing token still works.
     */
    readonly clearReauthRequired: (accountId: string) => Effect.Effect<void>;
    /**
     * Stamp `reauthRequiredAt` on the account and broadcast
     * `auth:reauth-required` to its connected clients. Called when a token is
     * invalid and could not be refreshed.
     */
    readonly markReauthRequired: (accountId: string) => Effect.Effect<void>;
  }
>() {}

export const TokenProviderLive = Layer.effect(
  TokenProvider,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const secretStore = yield* SecretStore;
    const broadcaster = yield* Broadcaster;

    // De-dupe concurrent refreshes of the same account — PollScheduler fans
    // out per-repo and would otherwise fire N parallel refresh grants, each
    // invalidating the previous one's rotated refresh token. Holds the
    // in-flight grant per account as a Deferred so followers await the leader.
    const refreshInFlight = yield* Ref.make(
      new Map<string, Deferred.Deferred<string, GitHubAuthError>>(),
    );

    /** Derive the GitHub host from a `github:{host}` (or legacy `github`) providerId. */
    function hostFromProviderId(providerId: string): string {
      return providerId.split(":")[1] ?? serverEnv.githubHost;
    }

    /** Exchange the stored refresh token for a fresh access token. Composed as
     * an Effect end-to-end — secret-store reads/writes and the SSE broadcast are
     * `yield*`-ed rather than escaped via `Effect.runPromise` (CLAUDE.md §2). */
    const doRefresh = (accountId: string): Effect.Effect<string, GitHubAuthError> =>
      Effect.gen(function* () {
        const row = db
          .select({
            providerId: account.providerId,
            refreshTokenExpiresAt: account.refreshTokenExpiresAt,
          })
          .from(account)
          .where(eq(account.id, accountId))
          .get();
        if (!row) {
          return yield* Effect.fail(
            new GitHubAuthError({ message: `account ${accountId} not found` }),
          );
        }

        const stored = yield* secretStore.getTokens(accountId);
        const refreshToken = stored?.refreshToken ?? null;
        if (!refreshToken) {
          return yield* Effect.fail(new GitHubAuthError({ message: "no refresh token available" }));
        }
        if (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt.getTime() < Date.now()) {
          return yield* Effect.fail(new GitHubAuthError({ message: "refresh token expired" }));
        }

        const host = hostFromProviderId(row.providerId);
        // The refresh grant must use the same client_id the token was minted
        // with. For a user-added GHE host that's the BYO client ID in settings;
        // for the bundled hosts the resolver falls back to server config. The
        // custom ID only applies to the host it was saved with.
        const settingsRow = db
          .select({
            githubHost: userSettings.githubHost,
            githubClientId: userSettings.githubClientId,
          })
          .from(userSettings)
          .where(eq(userSettings.id, "default"))
          .get();
        const customClientId = settingsRow?.githubHost === host ? settingsRow.githubClientId : null;
        const { status, data } = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(tokenUrlForHost(host), {
              method: "POST",
              headers: { Accept: "application/json", "Content-Type": "application/json" },
              body: JSON.stringify({
                client_id: clientIdForHost(host, customClientId),
                grant_type: "refresh_token",
                refresh_token: refreshToken,
              }),
            });
            return { status: res.status, data: (await res.json()) as RefreshResponse };
          },
          catch: (e) => new GitHubAuthError({ message: String(e) }),
        });
        if (!data.access_token) {
          return yield* Effect.fail(
            new GitHubAuthError({ message: data.error ?? `refresh failed (HTTP ${status})` }),
          );
        }

        const now = new Date();
        const accessToken = data.access_token;
        const newRefresh = data.refresh_token ?? refreshToken;
        yield* secretStore.setTokens(accountId, { accessToken, refreshToken: newRefresh });
        yield* Effect.sync(() =>
          db
            .update(account)
            .set({
              accessTokenExpiresAt: data.expires_in
                ? new Date(now.getTime() + data.expires_in * 1000)
                : null,
              refreshTokenExpiresAt: data.refresh_token_expires_in
                ? new Date(now.getTime() + data.refresh_token_expires_in * 1000)
                : row.refreshTokenExpiresAt,
              reauthRequiredAt: null,
              updatedAt: now,
            })
            .where(eq(account.id, accountId))
            .run(),
        );

        yield* broadcaster.broadcastToAccount(accountId, {
          type: "auth:reauth-cleared",
          data: { host },
        });
        return accessToken;
      });

    const refreshAccountToken = (accountId: string): Effect.Effect<string, GitHubAuthError> =>
      Effect.gen(function* () {
        // Atomically claim the in-flight slot: the leader installs its own
        // Deferred and runs the grant; followers receive the leader's Deferred
        // and await its outcome instead of issuing a second grant.
        const own = yield* Deferred.make<string, GitHubAuthError>();
        const leader = yield* Ref.modify(refreshInFlight, (m) => {
          const existing = m.get(accountId);
          if (existing) return [existing, m] as const;
          return [own, new Map(m).set(accountId, own)] as const;
        });
        if (leader !== own) return yield* Deferred.await(leader);

        const exit = yield* Effect.exit(doRefresh(accountId));
        yield* Ref.update(refreshInFlight, (m) => {
          const next = new Map(m);
          next.delete(accountId);
          return next;
        });
        yield* Deferred.done(own, exit);
        return yield* Deferred.await(own);
      });

    const markReauthRequired = (accountId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const row = db
          .select({ providerId: account.providerId, githubLogin: account.githubLogin })
          .from(account)
          .where(eq(account.id, accountId))
          .get();
        if (!row) return;
        yield* Effect.sync(() =>
          db
            .update(account)
            .set({ reauthRequiredAt: new Date(), updatedAt: new Date() })
            .where(eq(account.id, accountId))
            .run(),
        );
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "auth:reauth-required",
          data: { host: hostFromProviderId(row.providerId), githubLogin: row.githubLogin ?? null },
        });
      });

    const clearReauthRequired = (accountId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const row = db
          .select({
            providerId: account.providerId,
            reauthRequiredAt: account.reauthRequiredAt,
          })
          .from(account)
          .where(eq(account.id, accountId))
          .get();
        if (!row) return;
        if (row.reauthRequiredAt) {
          yield* Effect.sync(() =>
            db
              .update(account)
              .set({ reauthRequiredAt: null, updatedAt: new Date() })
              .where(eq(account.id, accountId))
              .run(),
          );
        }
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "auth:reauth-cleared",
          data: { host: hostFromProviderId(row.providerId) },
        });
      });

    const storeAccountTokens = (
      accountId: string,
      _host: string,
      tokens: TokenPair,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* secretStore.setTokens(accountId, tokens);
        yield* clearReauthRequired(accountId);
      });

    const deleteAccountTokens = (accountId: string): Effect.Effect<void> =>
      secretStore.deleteTokens(accountId);

    /** Refresh `accessToken` if it's within {@link REFRESH_SKEW_MS} of expiry
     * and a refresh token exists. Best-effort: on refresh failure, return the
     * existing token and let the eventual 401 drive `markReauthRequired`. */
    const maybeRefresh = (
      accountId: string,
      accessTokenExpiresAt: Date | null,
      accessToken: string,
      refreshToken: string | null,
    ): Effect.Effect<string> => {
      const exp = accessTokenExpiresAt?.getTime();
      const nearExpiry = exp != null && exp - Date.now() < REFRESH_SKEW_MS;
      if (!nearExpiry || !refreshToken) return Effect.succeed(accessToken);
      return refreshAccountToken(accountId).pipe(Effect.orElseSucceed(() => accessToken));
    };

    function resolveUserId(userId: string): string {
      if (userId && userId !== "single-user") return userId;
      const firstRow = db.select({ id: user.id }).from(user).limit(1).get();
      if (!firstRow) throw new Error("No user found");
      return firstRow.id;
    }

    /** Resolve the active account (id + provider + a valid token) for a user. */
    const resolveValid = (
      userId: string,
      host?: string,
    ): Effect.Effect<
      { accountId: string; accessToken: string; providerId: string; githubLogin: string | null },
      GitHubAuthError
    > =>
      Effect.gen(function* () {
        const resolvedId = yield* Effect.try({
          try: () => resolveUserId(userId),
          catch: (e) => new GitHubAuthError({ message: String(e) }),
        });

        const rows = db
          .select({
            id: account.id,
            providerId: account.providerId,
            githubLogin: account.githubLogin,
            accessTokenExpiresAt: account.accessTokenExpiresAt,
          })
          .from(account)
          .where(eq(account.userId, resolvedId))
          .all();

        // Priority order: requested host first, then defaults, then the
        // legacy 'github' provider. Falls back to any remaining account the
        // user owns (mirrors the prior behavior for non-default GHE hosts that
        // open an SSE stream without a `host=` param — see git history).
        const providerIds = host
          ? [`github:${host}`, "github"]
          : ["github:github.com", `github:${serverEnv.githubHost}`, "github"];
        const ordered: typeof rows = [];
        for (const pid of providerIds) {
          const m = rows.find((r) => r.providerId === pid);
          if (m && !ordered.includes(m)) ordered.push(m);
        }
        for (const r of rows) if (!ordered.includes(r)) ordered.push(r);

        for (const meta of ordered) {
          const stored = yield* secretStore.getTokens(meta.id);
          if (!stored?.accessToken) continue;
          const token = yield* maybeRefresh(
            meta.id,
            meta.accessTokenExpiresAt,
            stored.accessToken,
            stored.refreshToken,
          );
          return {
            accountId: meta.id,
            accessToken: token,
            providerId: meta.providerId,
            githubLogin: meta.githubLogin ?? null,
          };
        }
        return yield* Effect.fail(new GitHubAuthError({ message: "No access token found" }));
      });

    return {
      getGitHubToken: (userId, host) =>
        resolveValid(userId, host).pipe(Effect.map((r) => r.accessToken)),

      resolveAccount: (userId, host) => resolveValid(userId, host),

      getTokenByAccountId: (accountId) =>
        Effect.gen(function* () {
          const row = db
            .select({ accessTokenExpiresAt: account.accessTokenExpiresAt })
            .from(account)
            .where(eq(account.id, accountId))
            .get();
          const stored = yield* secretStore.getTokens(accountId);
          if (!stored?.accessToken) {
            return yield* Effect.fail(
              new GitHubAuthError({ message: `No access token for account ${accountId}` }),
            );
          }
          return yield* maybeRefresh(
            accountId,
            row?.accessTokenExpiresAt ?? null,
            stored.accessToken,
            stored.refreshToken,
          );
        }),

      storeAccountTokens,
      deleteAccountTokens,
      refreshAccountToken,
      clearReauthRequired,
      markReauthRequired,
    };
  }),
);
