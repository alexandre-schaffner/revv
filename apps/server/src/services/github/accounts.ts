import { and, eq, gt, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { account, repositories, session, user } from "../../db/schema";
import { avatarOfHostLogin } from "../../db/schema/remote-users";
import {
  type DbError,
  GitHubAuthError,
  type GitHubError,
  type GitHubRateLimitError,
  NotFoundError,
} from "../../domain/errors";
import {
  hostFromProviderId,
  providerIdForHost,
  providerIdsForHost,
} from "../../domain/github-host";
import { dbTry } from "../../effects/db-try";
import { keyedSingleFlight } from "../../effects/keyed-single-flight";
import { resolveClientId } from "../../github-oauth";
import { logError } from "../../logger";
import { DbService } from "../Db";
import { Realtime } from "../Realtime";
import { migrateLegacyTokens, SecretStore, type TokenPair } from "../SecretStore";
import { SettingsService } from "../Settings";
import { deviceFlowScopeFor, type IssuedTokens, refreshGrant } from "./oauth";
import { type GitHubClient, githubClient, makeHttp, type TransportObserver } from "./transport";
import { usersApi } from "./users";

/**
 * Unobserved: these reads run while an account's auth state is being decided,
 * so their own 401s must not report back here.
 */
const users = usersApi(makeHttp(null, null));

/**
 * GitHub's separate primary rate-limit budgets, as named by
 * `X-RateLimit-Resource`. Exhausting one says nothing about the others: a
 * spent GraphQL budget leaves REST — where a conditional 304 is free — fully
 * usable.
 */
export type GitHubBudget = "core" | "graphql" | "search";

type PauseScope = GitHubBudget | "all";

function pauseScopeOf(err: GitHubRateLimitError): PauseScope {
  // Secondary (abuse) limits count every request, REST and GraphQL alike.
  if (err.kind !== "primary") return "all";
  if (err.resource === "graphql" || err.resource === "search") return err.resource;
  return "core";
}

export interface AccountIdentity {
  readonly accountId: string;
  readonly userId: string;
  readonly host: string;
  readonly githubLogin: string | null;
  readonly client: GitHubClient;
}

export interface AccountProfile {
  readonly accountId: string;
  readonly userId: string;
  readonly host: string;
  readonly githubLogin: string | null;
  /** GitHub's numeric user id. */
  readonly githubUserId: string;
}

export interface LocalUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly accounts: ReadonlyArray<{
    readonly host: string;
    readonly githubLogin: string | null;
    readonly avatarUrl: string | null;
  }>;
}

export interface ConnectedHost {
  readonly host: string;
  readonly connected: boolean;
  readonly githubLogin: string | null;
  readonly avatarUrl: string | null;
}

export interface UserProfile {
  readonly githubLogin: string | null;
  readonly image: string | null;
  readonly onboardedAt: Date | null;
}

/** Hosts Revv ships a client ID for: always listed in a user's hosts, connected or not. */
const BUNDLED_HOSTS = ["github.com"] as const;

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The owner of local GitHub accounts: their tokens, their re-auth state and
 * their identity. The only minter of {@link GitHubClient}s for an account.
 *
 * `account.reauth_required_at` is the one truth for "this account must sign in
 * again", and this service is its only writer, so its in-memory copy can't
 * drift from the row.
 */
export class GitHubAccounts extends Context.Service<
  GitHubAccounts,
  {
    /** A client for the account, its token refreshed when near expiry. Fails without a token. */
    readonly clientFor: (accountId: string) => Effect.Effect<GitHubClient, GitHubAuthError>;
    /**
     * The user's account on `host`, for work a signed-in user asked for. A
     * user with no usable account there gets another of their accounts (whose
     * client still addresses its own host).
     */
    readonly accountForUser: (
      userId: string,
      host: string,
    ) => Effect.Effect<AccountIdentity, GitHubAuthError>;
    /**
     * A client for background work, or null when the account must not be
     * called now: it needs re-auth, has no token, or is paused for `budget`
     * (or for every budget) after a rate limit. Omit `budget` to ask whether
     * it can make some request.
     */
    readonly backgroundClient: (
      accountId: string,
      budget?: GitHubBudget,
    ) => Effect.Effect<GitHubClient | null>;
    /** Wired into the gateway's transport: every account's 401s and rate limits land here. */
    readonly observer: TransportObserver;
    readonly reauthRequired: (accountId: string) => Effect.Effect<boolean>;
    /**
     * For an account flagged for re-auth, ask GitHub whether its token works
     * after all (a 401 can be transient: an SSO or gateway hiccup) and clear
     * the flag if it does. Resolves whether the account still needs re-auth.
     */
    readonly probeFlagged: (accountId: string) => Effect.Effect<boolean>;
    readonly profile: (accountId: string) => Effect.Effect<AccountProfile, DbError | NotFoundError>;
    /**
     * The login Revv treats as "me" for this account's repositories: its
     * user's `github_login`, the one the UI shows and compares with. Not the
     * account's own login, which can differ on GitHub Enterprise.
     */
    readonly viewerLogin: (accountId: string) => Effect.Effect<string | null, DbError>;
    /**
     * Record what GitHub says the account's login and avatar are now. When
     * they moved, the account's user mirror (`user.github_login` /
     * `user.image`, what the UI shows) follows and `user:updated` goes out.
     */
    readonly recordIdentity: (
      accountId: string,
      identity: { readonly login: string; readonly avatarUrl: string | null },
    ) => Effect.Effect<void, DbError>;
    /**
     * Finish a device-flow sign-in: read who the token belongs to, and record
     * the account. Without `linkToUserId` the GitHub user becomes (or matches,
     * by email) a local user and gets a new session; with it, the account is
     * attached to that already signed-in user.
     */
    readonly signIn: (input: {
      readonly host: string;
      readonly clientId: string;
      readonly tokens: IssuedTokens;
      readonly linkToUserId: string | null;
    }) => Effect.Effect<
      { readonly userId: string; readonly sessionToken: string | null },
      GitHubError | DbError | GitHubAuthError
    >;
    /** The user behind a live session token, or null. */
    readonly sessionUser: (sessionToken: string) => Effect.Effect<string | null, DbError>;
    /** A new session for another local user that is signed in on this machine. */
    readonly switchTo: (targetUserId: string) => Effect.Effect<string | null, DbError>;
    /** Local users with a live session, and their accounts per host. */
    readonly localUsers: Effect.Effect<LocalUser[], DbError>;
    readonly connectedHosts: (userId: string) => Effect.Effect<ConnectedHost[], DbError>;
    /**
     * Forget the user's account on `host`, locally: GitHub can't revoke a
     * device-flow grant without the client secret Revv never has.
     */
    readonly disconnect: (userId: string, host: string) => Effect.Effect<void, DbError>;
    /** Delete the user, their accounts, sessions, tracked repositories and stored tokens. */
    readonly removeUser: (userId: string) => Effect.Effect<void, DbError>;
    readonly userProfile: (userId: string) => Effect.Effect<UserProfile | null, DbError>;
    /** Fill in `user.github_login` / `user.image` that are missing. */
    readonly backfillUserProfile: (
      userId: string,
      values: { readonly githubLogin?: string; readonly image?: string | null },
    ) => Effect.Effect<void, DbError>;
    /** legacy-upgrade: plaintextTokens. See `migrateLegacyTokens`. */
    readonly migrateLegacyTokens: Effect.Effect<number>;
  }
>()("GitHubAccounts") {}

export const GitHubAccountsLive = Layer.effect(
  GitHubAccounts,
  Effect.gen(function* () {
    const dbService = yield* DbService;
    const { db } = dbService;
    const secretStore = yield* SecretStore;
    const realtime = yield* Realtime;
    const settings = yield* SettingsService;

    // A copy of the secure store, which costs a keychain read per call. This
    // service makes every write, so the copy is updated in the same step.
    const tokenCache = new Map<string, TokenPair | null>();

    const tokensOf = (accountId: string): Effect.Effect<TokenPair | null> =>
      tokenCache.has(accountId)
        ? Effect.succeed(tokenCache.get(accountId) ?? null)
        : secretStore
            .getTokens(accountId)
            .pipe(Effect.tap((tokens) => Effect.sync(() => tokenCache.set(accountId, tokens))));

    const storeTokens = (accountId: string, tokens: TokenPair): Effect.Effect<void> =>
      secretStore
        .setTokens(accountId, tokens)
        .pipe(Effect.tap(() => Effect.sync(() => tokenCache.set(accountId, tokens))));

    const deleteTokens = (accountId: string): Effect.Effect<void> =>
      secretStore
        .deleteTokens(accountId)
        .pipe(Effect.tap(() => Effect.sync(() => tokenCache.delete(accountId))));

    const readRow = (accountId: string) =>
      dbTry("read account", () =>
        db
          .select({
            id: account.id,
            userId: account.userId,
            accountId: account.accountId,
            providerId: account.providerId,
            githubLogin: account.githubLogin,
            avatarUrl: account.avatarUrl,
            accessTokenExpiresAt: account.accessTokenExpiresAt,
            refreshTokenExpiresAt: account.refreshTokenExpiresAt,
            reauthRequiredAt: account.reauthRequiredAt,
          })
          .from(account)
          .where(eq(account.id, accountId))
          .get(),
      );

    const authFailure = (message: string) => new GitHubAuthError({ message });

    const reauthCache = new Map<string, boolean>();

    const reauthRequired = (accountId: string): Effect.Effect<boolean> =>
      reauthCache.has(accountId)
        ? Effect.succeed(reauthCache.get(accountId) === true)
        : readRow(accountId).pipe(
            Effect.map((row) => row?.reauthRequiredAt != null),
            Effect.tap((flagged) => Effect.sync(() => reauthCache.set(accountId, flagged))),
            Effect.catch((e) =>
              Effect.sync(() => {
                logError("GitHubAccounts", e.message);
                return false;
              }),
            ),
          );

    const markReauthRequired = (accountId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const row = yield* readRow(accountId);
        if (!row) return;
        yield* dbTry("stamp reauth_required_at", () =>
          db
            .update(account)
            .set({ reauthRequiredAt: new Date(), updatedAt: new Date() })
            .where(eq(account.id, accountId))
            .run(),
        );
        reauthCache.set(accountId, true);
        logError(
          "GitHubAccounts",
          `Account ${row.githubLogin ?? accountId} returned 401 and could not be refreshed — it needs to sign in again.`,
        );
        yield* realtime.toAccount(accountId, {
          type: "auth:reauth-required",
          data: { host: hostFromProviderId(row.providerId), githubLogin: row.githubLogin ?? null },
        });
      }).pipe(Effect.catch((e) => Effect.sync(() => logError("GitHubAccounts", e.message))));

    const clearReauthRequired = (accountId: string): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const row = yield* readRow(accountId);
        if (!row) return;
        if (row.reauthRequiredAt) {
          yield* dbTry("clear reauth_required_at", () =>
            db
              .update(account)
              .set({ reauthRequiredAt: null, updatedAt: new Date() })
              .where(eq(account.id, accountId))
              .run(),
          );
        }
        reauthCache.set(accountId, false);
        yield* realtime.toAccount(accountId, {
          type: "auth:reauth-cleared",
          data: { host: hostFromProviderId(row.providerId) },
        });
      });

    // One grant per account at a time: concurrent grants would each invalidate
    // the previous one's rotated refresh token.
    const refreshOnce = keyedSingleFlight<string, string, GitHubAuthError>();

    const doRefresh = (accountId: string): Effect.Effect<string, GitHubAuthError> =>
      Effect.gen(function* () {
        const row = yield* readRow(accountId).pipe(Effect.mapError((e) => authFailure(e.message)));
        if (!row) return yield* Effect.fail(authFailure(`account ${accountId} not found`));
        const refreshToken = (yield* tokensOf(accountId))?.refreshToken ?? null;
        if (!refreshToken) return yield* Effect.fail(authFailure("no refresh token available"));
        if (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt.getTime() < Date.now()) {
          return yield* Effect.fail(authFailure("refresh token expired"));
        }

        const host = hostFromProviderId(row.providerId);
        // The grant must use the client_id the token was minted with.
        const saved = yield* settings.getSettings();
        const clientId = yield* Effect.try({
          try: () => resolveClientId(host, saved),
          catch: (e) => authFailure(e instanceof Error ? e.message : String(e)),
        });
        const { status, data } = yield* refreshGrant(host, clientId, refreshToken).pipe(
          Effect.mapError((e) => authFailure(String(e))),
        );
        if (!data.access_token) {
          return yield* Effect.fail(authFailure(data.error ?? `refresh failed (HTTP ${status})`));
        }

        const now = new Date();
        const accessToken = data.access_token;
        yield* storeTokens(accountId, {
          accessToken,
          refreshToken: data.refresh_token ?? refreshToken,
        });
        yield* dbTry("record refreshed token expiry", () =>
          db
            .update(account)
            .set({
              accessTokenExpiresAt: data.expires_in
                ? new Date(now.getTime() + data.expires_in * 1000)
                : null,
              refreshTokenExpiresAt: data.refresh_token_expires_in
                ? new Date(now.getTime() + data.refresh_token_expires_in * 1000)
                : row.refreshTokenExpiresAt,
              updatedAt: now,
            })
            .where(eq(account.id, accountId))
            .run(),
        ).pipe(Effect.mapError((e) => authFailure(e.message)));
        yield* clearReauthRequired(accountId).pipe(Effect.mapError((e) => authFailure(e.message)));
        return accessToken;
      });

    const refresh = (accountId: string) => refreshOnce(accountId, doRefresh(accountId));

    /** The stored token, refreshed first when it is about to expire. A failed refresh keeps the old one. */
    const liveToken = (
      accountId: string,
      expiresAt: Date | null,
    ): Effect.Effect<string, GitHubAuthError> =>
      Effect.gen(function* () {
        const stored = yield* tokensOf(accountId);
        if (!stored?.accessToken) {
          return yield* Effect.fail(authFailure(`No access token for account ${accountId}`));
        }
        const exp = expiresAt?.getTime();
        const nearExpiry = exp != null && exp - Date.now() < REFRESH_SKEW_MS;
        if (!nearExpiry || !stored.refreshToken) return stored.accessToken;
        const token = stored.accessToken;
        return yield* refresh(accountId).pipe(Effect.orElseSucceed(() => token));
      });

    const clientFor = (accountId: string): Effect.Effect<GitHubClient, GitHubAuthError> =>
      Effect.gen(function* () {
        const row = yield* readRow(accountId).pipe(Effect.mapError((e) => authFailure(e.message)));
        if (!row) return yield* Effect.fail(authFailure(`account ${accountId} not found`));
        const token = yield* liveToken(accountId, row.accessTokenExpiresAt);
        return githubClient(hostFromProviderId(row.providerId), token, accountId);
      });

    const accountForUser = (
      userId: string,
      host: string,
    ): Effect.Effect<AccountIdentity, GitHubAuthError> =>
      Effect.gen(function* () {
        const rows = yield* dbTry("read user accounts", () =>
          db
            .select({
              id: account.id,
              providerId: account.providerId,
              githubLogin: account.githubLogin,
              accessTokenExpiresAt: account.accessTokenExpiresAt,
            })
            .from(account)
            .where(eq(account.userId, userId))
            .all(),
        ).pipe(Effect.mapError((e) => authFailure(e.message)));
        const preferred = providerIdsForHost(host);
        const ordered = [
          ...preferred.flatMap((pid) => rows.filter((r) => r.providerId === pid)),
          ...rows.filter((r) => !preferred.includes(r.providerId)),
        ];
        for (const row of ordered) {
          if (!(yield* tokensOf(row.id))?.accessToken) continue;
          const token = yield* liveToken(row.id, row.accessTokenExpiresAt);
          const accountHost = hostFromProviderId(row.providerId);
          return {
            accountId: row.id,
            userId,
            host: accountHost,
            githubLogin: row.githubLogin ?? null,
            client: githubClient(accountHost, token, row.id),
          };
        }
        return yield* Effect.fail(authFailure("No access token found"));
      });

    const pauses = new Map<string, Map<PauseScope, number>>();

    const isPausedFor = (accountId: string, scope: PauseScope): boolean => {
      const byScope = pauses.get(accountId);
      const until = byScope?.get(scope);
      if (byScope === undefined || until === undefined) return false;
      if (Date.now() < until) return true;
      byScope.delete(scope);
      return false;
    };

    const rateLimited = (client: GitHubClient, err: GitHubRateLimitError): Effect.Effect<void> =>
      Effect.sync(() => {
        const accountId = client.accountId;
        if (accountId === null) return;
        const now = Date.now();
        const resetAt = err.resetAt.getTime();
        const retryAfterMs = err.retryAfter === undefined ? 0 : err.retryAfter * 1000;
        const until = Math.max(
          Number.isFinite(resetAt) ? resetAt : 0,
          now + retryAfterMs,
          now + 60_000,
        );
        const scope = pauseScopeOf(err);
        let byScope = pauses.get(accountId);
        if (!byScope) {
          byScope = new Map();
          pauses.set(accountId, byScope);
        }
        const existingUntil = byScope.get(scope);
        byScope.set(scope, Math.max(existingUntil ?? 0, until));
        if (existingUntil !== undefined && existingUntil > now) return;
        const what =
          scope === "all" ? "GitHub sync" : `GitHub ${scope === "core" ? "REST" : scope} calls`;
        logError(
          "GitHubAccounts",
          `Account ${accountId} hit GitHub ${err.kind ?? "unknown"} rate limit (${err.resource ?? "unknown resource"}) — pausing ${what} for this account until ${new Date(until).toISOString()}.`,
        );
      });

    const tokenWorks = (accountId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const row = yield* readRow(accountId);
        const token = (yield* tokensOf(accountId))?.accessToken;
        if (!row || !token) return false;
        return yield* users
          .viewer(githubClient(hostFromProviderId(row.providerId), token, accountId))
          .pipe(Effect.as(true));
      }).pipe(Effect.orElseSucceed(() => false));

    const authFailures = keyedSingleFlight<string, void, never>();

    const unauthorized = (client: GitHubClient): Effect.Effect<void> => {
      const accountId = client.accountId;
      if (accountId === null) return Effect.void;
      return Effect.gen(function* () {
        if (yield* reauthRequired(accountId)) return;
        // A request made with a token that has since been replaced says
        // nothing about the current one.
        if ((yield* tokensOf(accountId))?.accessToken !== client.token) return;
        yield* authFailures(
          accountId,
          Effect.gen(function* () {
            const refreshed = yield* refresh(accountId).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (refreshed) return;
            if (yield* tokenWorks(accountId)) return;
            yield* markReauthRequired(accountId);
          }),
        );
      });
    };

    const probeFlagged = (accountId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (!(yield* reauthRequired(accountId))) return false;
        if (!(yield* tokenWorks(accountId))) return true;
        yield* clearReauthRequired(accountId);
        return false;
      }).pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            logError("GitHubAccounts", e.message);
            return true;
          }),
        ),
      );

    const backgroundClient = (
      accountId: string,
      budget?: GitHubBudget,
    ): Effect.Effect<GitHubClient | null> =>
      Effect.gen(function* () {
        if (yield* reauthRequired(accountId)) return null;
        if (isPausedFor(accountId, "all")) return null;
        if (budget !== undefined && isPausedFor(accountId, budget)) return null;
        return yield* clientFor(accountId).pipe(Effect.orElseSucceed(() => null));
      });

    const viewerLogin = (accountId: string): Effect.Effect<string | null, DbError> =>
      dbTry("read viewer login", () =>
        db
          .select({ login: user.githubLogin })
          .from(account)
          .innerJoin(user, eq(user.id, account.userId))
          .where(eq(account.id, accountId))
          .get(),
      ).pipe(Effect.map((row) => row?.login ?? null));

    const profile = (accountId: string): Effect.Effect<AccountProfile, DbError | NotFoundError> =>
      readRow(accountId).pipe(
        Effect.flatMap((row) =>
          row
            ? Effect.succeed({
                accountId: row.id,
                userId: row.userId,
                host: hostFromProviderId(row.providerId),
                githubLogin: row.githubLogin ?? null,
                githubUserId: row.accountId,
              })
            : Effect.fail(new NotFoundError({ resource: "account", id: accountId })),
        ),
      );

    const recordIdentity = (
      accountId: string,
      identity: { readonly login: string; readonly avatarUrl: string | null },
    ): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const row = yield* readRow(accountId);
        if (!row) return;
        if (row.githubLogin === identity.login && row.avatarUrl === identity.avatarUrl) return;
        const now = new Date();
        yield* dbTry("record account identity", () =>
          db
            .update(account)
            .set({ githubLogin: identity.login, avatarUrl: identity.avatarUrl, updatedAt: now })
            .where(eq(account.id, accountId))
            .run(),
        );
        const userRow = yield* dbTry("read user", () =>
          db
            .select({
              id: user.id,
              name: user.name,
              email: user.email,
              image: user.image,
              githubLogin: user.githubLogin,
              avatarContent: avatarOfHostLogin(identity.login, hostFromProviderId(row.providerId)),
            })
            .from(user)
            .where(eq(user.id, row.userId))
            .get(),
        );
        if (!userRow) return;
        if (userRow.image !== identity.avatarUrl || userRow.githubLogin !== identity.login) {
          yield* dbTry("mirror identity to user", () =>
            db
              .update(user)
              .set({ image: identity.avatarUrl, githubLogin: identity.login, updatedAt: now })
              .where(eq(user.id, row.userId))
              .run(),
          );
        }
        yield* realtime.toAccount(accountId, {
          type: "user:updated",
          data: {
            id: userRow.id,
            name: userRow.name,
            email: userRow.email,
            avatarContent: userRow.avatarContent,
            githubLogin: identity.login,
          },
        });
      });

    const mintSession = (userId: string): Effect.Effect<string, DbError> =>
      dbTry("create session", () => {
        const token = newSessionToken();
        const now = new Date();
        db.insert(session)
          .values({
            id: crypto.randomUUID(),
            token,
            userId,
            expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
            createdAt: now,
            updatedAt: now,
          })
          .run();
        return token;
      });

    /**
     * The account row for a GitHub identity on a host: the row of that GitHub
     * user, else (linking) the row the local user already has on the host,
     * which now holds the new GitHub identity.
     */
    const upsertAccount = (input: {
      readonly userId: string;
      readonly host: string;
      readonly clientId: string;
      readonly githubUserId: string;
      readonly login: string;
      readonly avatarUrl: string | null;
      readonly tokens: IssuedTokens;
    }): Effect.Effect<string, DbError> =>
      dbTry("upsert account", () => {
        const providerIds = providerIdsForHost(input.host);
        const onHost = db
          .select({ id: account.id, accountId: account.accountId, userId: account.userId })
          .from(account)
          .where(inArray(account.providerId, providerIds))
          .all();
        const existing =
          onHost.find((r) => r.accountId === input.githubUserId) ??
          onHost.find((r) => r.userId === input.userId);
        const now = new Date();
        const values = {
          accountId: input.githubUserId,
          userId: input.userId,
          githubLogin: input.login,
          avatarUrl: input.avatarUrl,
          accessTokenExpiresAt: input.tokens.accessTokenExpiresAt,
          refreshTokenExpiresAt: input.tokens.refreshTokenExpiresAt,
          reauthRequiredAt: null,
          updatedAt: now,
        };
        if (existing) {
          db.update(account).set(values).where(eq(account.id, existing.id)).run();
          return existing.id;
        }
        const id = crypto.randomUUID();
        db.insert(account)
          .values({
            ...values,
            id,
            providerId: providerIdForHost(input.host),
            scope: deviceFlowScopeFor(input.clientId),
            createdAt: now,
          })
          .run();
        return id;
      });

    const upsertUserByEmail = (input: {
      readonly email: string;
      readonly name: string;
      readonly login: string;
      readonly avatarUrl: string | null;
    }): Effect.Effect<string, DbError> =>
      dbTry("upsert user", () => {
        const now = new Date();
        const existing = db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, input.email))
          .get();
        if (existing) {
          db.update(user)
            .set({
              name: input.name,
              image: input.avatarUrl,
              githubLogin: input.login,
              updatedAt: now,
            })
            .where(eq(user.id, existing.id))
            .run();
          return existing.id;
        }
        const id = crypto.randomUUID();
        db.insert(user)
          .values({
            id,
            name: input.name,
            email: input.email,
            emailVerified: true,
            image: input.avatarUrl,
            githubLogin: input.login,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        return id;
      });

    const signIn: Context.Service.Shape<typeof GitHubAccounts>["signIn"] = (input) =>
      Effect.gen(function* () {
        const probe = githubClient(input.host, input.tokens.accessToken, null);
        const viewer = yield* users.viewer(probe);
        let userId = input.linkToUserId;
        if (userId === null) {
          const email =
            (yield* users.primaryEmail(probe).pipe(Effect.orElseSucceed(() => null))) ??
            viewer.email;
          if (!email) {
            return yield* Effect.fail(authFailure("No email address found on GitHub account"));
          }
          userId = yield* upsertUserByEmail({
            email,
            name: viewer.name ?? viewer.login,
            login: viewer.login,
            avatarUrl: viewer.avatarUrl,
          });
        }
        const accountId = yield* upsertAccount({
          userId,
          host: input.host,
          clientId: input.clientId,
          githubUserId: String(viewer.id),
          login: viewer.login,
          avatarUrl: viewer.avatarUrl,
          tokens: input.tokens,
        });
        yield* storeTokens(accountId, {
          accessToken: input.tokens.accessToken,
          refreshToken: input.tokens.refreshToken,
        });
        yield* clearReauthRequired(accountId);
        const sessionToken = input.linkToUserId === null ? yield* mintSession(userId) : null;
        return { userId, sessionToken };
      });

    const sessionUser = (sessionToken: string): Effect.Effect<string | null, DbError> =>
      dbTry("read session", () =>
        db
          .select({ userId: session.userId })
          .from(session)
          .where(and(eq(session.token, sessionToken), gt(session.expiresAt, new Date())))
          .get(),
      ).pipe(Effect.map((row) => row?.userId ?? null));

    const switchTo = (targetUserId: string): Effect.Effect<string | null, DbError> =>
      Effect.gen(function* () {
        const live = yield* dbTry("read target session", () =>
          db
            .select({ id: session.id })
            .from(session)
            .where(and(eq(session.userId, targetUserId), gt(session.expiresAt, new Date())))
            .get(),
        );
        if (!live) return null;
        return yield* mintSession(targetUserId);
      });

    const localUsers: Effect.Effect<LocalUser[], DbError> = dbTry("list local users", () => {
      const userIds = [
        ...new Set(
          db
            .select({ userId: session.userId })
            .from(session)
            .where(gt(session.expiresAt, new Date()))
            .all()
            .map((s) => s.userId),
        ),
      ];
      if (userIds.length === 0) return [];
      const users = db
        .select({ id: user.id, name: user.name, email: user.email, image: user.image })
        .from(user)
        .where(inArray(user.id, userIds))
        .all();
      const accounts = db
        .select({
          userId: account.userId,
          providerId: account.providerId,
          githubLogin: account.githubLogin,
          avatarUrl: account.avatarUrl,
        })
        .from(account)
        .where(inArray(account.userId, userIds))
        .all();
      return users.map((u) => ({
        ...u,
        accounts: accounts
          .filter((a) => a.userId === u.id)
          .map((a) => ({
            host: hostFromProviderId(a.providerId),
            githubLogin: a.githubLogin ?? null,
            avatarUrl: a.avatarUrl ?? null,
          })),
      }));
    });

    const connectedHosts = (userId: string): Effect.Effect<ConnectedHost[], DbError> =>
      dbTry("list connected hosts", () => {
        const rows = db
          .select({
            providerId: account.providerId,
            githubLogin: account.githubLogin,
            avatarUrl: account.avatarUrl,
          })
          .from(account)
          .where(eq(account.userId, userId))
          .all();
        const byHost = new Map<string, { githubLogin: string | null; avatarUrl: string | null }>();
        for (const r of rows) {
          byHost.set(hostFromProviderId(r.providerId), {
            githubLogin: r.githubLogin ?? null,
            avatarUrl: r.avatarUrl ?? null,
          });
        }
        return [...new Set<string>([...BUNDLED_HOSTS, ...byHost.keys()])].map((host) => {
          const connected = byHost.get(host);
          return {
            host,
            connected: connected !== undefined,
            githubLogin: connected?.githubLogin ?? null,
            avatarUrl: connected?.avatarUrl ?? null,
          };
        });
      });

    const forgetAccounts = (ids: readonly string[]): Effect.Effect<void> =>
      Effect.forEach(
        ids,
        (id) =>
          deleteTokens(id).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                reauthCache.delete(id);
                pauses.delete(id);
              }),
            ),
          ),
        { discard: true },
      );

    const disconnect = (userId: string, host: string): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const where = and(
          inArray(account.providerId, providerIdsForHost(host)),
          eq(account.userId, userId),
        );
        const ids = yield* dbTry("disconnect account", () => {
          const rows = db.select({ id: account.id }).from(account).where(where).all();
          db.delete(account).where(where).run();
          return rows.map((r) => r.id);
        });
        yield* forgetAccounts(ids);
      });

    const removeUser = (userId: string): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const ids = yield* dbTry("remove user", () => {
          const ids = db
            .select({ id: account.id })
            .from(account)
            .where(eq(account.userId, userId))
            .all()
            .map((a) => a.id);
          // Repositories cascade from their account and sessions/accounts from
          // the user; pull requests and everything under them from the repository.
          if (ids.length > 0)
            db.delete(repositories).where(inArray(repositories.accountId, ids)).run();
          db.delete(user).where(eq(user.id, userId)).run();
          return ids;
        });
        yield* forgetAccounts(ids);
      });

    const userProfile = (userId: string): Effect.Effect<UserProfile | null, DbError> =>
      dbTry("read user profile", () =>
        db
          .select({
            githubLogin: user.githubLogin,
            image: user.image,
            onboardedAt: user.onboardedAt,
          })
          .from(user)
          .where(eq(user.id, userId))
          .get(),
      ).pipe(Effect.map((row) => row ?? null));

    const backfillUserProfile = (
      userId: string,
      values: { readonly githubLogin?: string; readonly image?: string | null },
    ): Effect.Effect<void, DbError> =>
      dbTry("backfill user profile", () =>
        db
          .update(user)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(user.id, userId))
          .run(),
      );

    return {
      clientFor,
      accountForUser,
      backgroundClient,
      observer: { unauthorized, rateLimited },
      reauthRequired,
      probeFlagged,
      profile,
      viewerLogin,
      recordIdentity,
      signIn,
      sessionUser,
      switchTo,
      localUsers,
      connectedHosts,
      disconnect,
      removeUser,
      userProfile,
      backfillUserProfile,
      migrateLegacyTokens: migrateLegacyTokens.pipe(
        Effect.provideService(SecretStore, secretStore),
        Effect.provideService(DbService, dbService),
        Effect.tap(() => Effect.sync(() => tokenCache.clear())),
      ),
    };
  }),
);
