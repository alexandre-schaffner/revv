/**
 * Per-cycle account context for `PollScheduler.syncAllRepos`: which account
 * owns each repo, its live token, and the guards every GitHub call of the
 * cycle runs through (bad token, rate-limit pause, reactive token refresh).
 *
 * The phase modules (`poll-open-prs`, `poll-maintenance`, `poll-notifications`)
 * take the {@link SyncCycle} this builds and never resolve accounts on their own.
 */
import type { ServerEventMessage } from "@revv/shared";
import { inArray } from "drizzle-orm";
import { type Context, Effect } from "effect";
import type { Db } from "../db/index";
import { account } from "../db/schema/auth";
import { GitHubAccessDeniedError, GitHubAuthError, GitHubRateLimitError } from "../domain/errors";
import { extractHostFromProviderId } from "../domain/provider-id";
import { debug, logError } from "../logger";
import type { Broadcaster } from "./Broadcaster";
import type { DbService } from "./Db";
import type { DiffCacheService } from "./DiffCache";
import type { GitHubGateway } from "./GitHub";
import type { GitHubEtagCache } from "./GitHubEtagCache";
import { apiBaseForHost, githubFetch } from "./github-rest";
import type { PullRequestService } from "./PullRequest";
import type { RemoteUserService } from "./RemoteUser";
import type { RepoCloneService } from "./RepoClone";
import type { RepositoryService } from "./Repository";
import type { SettingsService } from "./Settings";
import type { TokenProvider } from "./TokenProvider";
import type { WalkthroughService } from "./Walkthrough";
import type { WalkthroughJobs } from "./WalkthroughJobs";

/** The services the poll phases use, captured once at layer construction. */
export interface PollDeps {
  readonly db: Db;
  readonly broadcaster: Context.Tag.Service<typeof Broadcaster>;
  readonly github: Context.Tag.Service<typeof GitHubGateway>;
  readonly prService: Context.Tag.Service<typeof PullRequestService>;
  readonly remoteUserService: Context.Tag.Service<typeof RemoteUserService>;
  readonly diffCache: Context.Tag.Service<typeof DiffCacheService>;
  readonly repoService: Context.Tag.Service<typeof RepositoryService>;
  readonly walkthroughJobs: Context.Tag.Service<typeof WalkthroughJobs>;
  readonly walkthroughService: Context.Tag.Service<typeof WalkthroughService>;
  readonly repoClone: Context.Tag.Service<typeof RepoCloneService>;
  readonly tokenProvider: Context.Tag.Service<typeof TokenProvider>;
}

/** Best-effort account-scoped broadcast; a failed emit never fails the cycle. */
export const broadcastToAccount = (
  deps: PollDeps,
  accountId: string,
  msg: ServerEventMessage,
): Effect.Effect<void> =>
  deps.broadcaster.broadcastToAccount(accountId, msg).pipe(Effect.orElseSucceed(() => undefined));

/**
 * GitHub's separate primary rate-limit budgets, as named by
 * `X-RateLimit-Resource`. Exhausting one says nothing about the others: a
 * spent GraphQL budget leaves REST — where a conditional 304 is free — fully
 * usable, so pausing is tracked per budget.
 */
/** The services `github.*` calls read from context. */
export type GitHubInfra = DbService | GitHubEtagCache | SettingsService;

export type GitHubBudget = "core" | "graphql" | "search";

/** A budget, or `"all"` for a limit that counts every request. */
type PauseScope = GitHubBudget | "all";

function pauseScopeOf(err: GitHubRateLimitError): PauseScope {
  // Secondary (abuse) limits count every request, REST and GraphQL alike.
  if (err.kind !== "primary") return "all";
  if (err.resource === "graphql" || err.resource === "search") return err.resource;
  return "core";
}

/**
 * Account pauses that outlive a cycle. Coordination caches only — losing them
 * on restart costs one failing request per account, which re-arms them.
 */
export interface AccountPauses {
  /**
   * Accounts whose access token returned a 401, keyed on `accountId`, the
   * value being the exact token string we saw fail. While the DB row still has
   * that same token, every GitHub call for that account is skipped — no
   * listPrs, no archive backfill, no avatar refresh. A re-auth rotates the
   * token, so equality against the live token is the auto-clear: zero explicit
   * hooks needed.
   */
  readonly knownBadTokensByAccountId: Map<string, string>;
  readonly rateLimitedUntilByAccountId: Map<string, Map<PauseScope, number>>;
}

export const makeAccountPauses = (): AccountPauses => ({
  knownBadTokensByAccountId: new Map(),
  rateLimitedUntilByAccountId: new Map(),
});

export type AccountCtx = {
  readonly id: string;
  readonly userId: string;
  readonly host: string;
  readonly accessToken: string | null;
  readonly githubLogin: string | null;
  readonly avatarUrl: string | null;
};

export interface LiveAccount {
  readonly acc: AccountCtx;
  readonly token: string;
}

export interface SyncCycle {
  readonly repoToAccountId: ReadonlyMap<string, string>;
  readonly accountRows: readonly AccountCtx[];
  /**
   * Current account context, updated in place when a token is refreshed or an
   * identity refresh learns a new login/avatar mid-cycle.
   */
  readonly accountById: Map<string, AccountCtx>;
  /**
   * The account and token to call GitHub with, or null when the token is
   * missing, known bad, or the account is paused for `budget` (or for every
   * budget). Omit `budget` to ask only whether the account can make *some*
   * request. Single gate — every per-account / per-repo guard funnels through
   * this so the skip rules live in one place.
   */
  readonly liveAccount: (
    acc: AccountCtx | null | undefined,
    budget?: GitHubBudget,
  ) => LiveAccount | null;
  readonly liveAccountForRepo: (repoId: string, budget?: GitHubBudget) => LiveAccount | null;
  /**
   * Run a GitHub call with the account guards, returning the value or `null`
   * on any failure. A 401 tries one silent token refresh before pausing the
   * account; a rate limit pauses the budget it hit. Other errors are logged
   * under `errorLabel` when one is given.
   */
  readonly tryGuarded: <A, E, R>(
    acc: AccountCtx,
    eff: Effect.Effect<A, E, R>,
    opts?: { readonly errorLabel?: string },
  ) => Effect.Effect<A | null, never, R>;
}

export const openSyncCycle = (
  deps: PollDeps,
  pauses: AccountPauses,
  accountIds: readonly string[],
  repoToAccountId: ReadonlyMap<string, string>,
): Effect.Effect<SyncCycle> =>
  Effect.gen(function* () {
    const { db, tokenProvider, broadcaster } = deps;
    const { knownBadTokensByAccountId, rateLimitedUntilByAccountId } = pauses;

    // ── Hydrate per-repo account context ───────────────────────────────────
    // Each repo is bound to a specific `account.id` (its owning OAuth
    // connection). We resolve the per-repo account + token here, ONCE, and
    // use it everywhere in the cycle — instead of falling back to
    // `getGitHubToken("single-user", host)`, which silently picks "first user
    // in the user table, first account row matching the host" and therefore
    // mixes up identities the moment two users or two accounts on the same
    // host coexist on this machine.
    //
    // Token bytes live behind TokenProvider, not the DB. Fetch only the
    // metadata the scheduler needs, then let TokenProvider resolve and refresh
    // the usable access token.
    const accountMetaRows =
      accountIds.length > 0
        ? db
            .select({
              id: account.id,
              userId: account.userId,
              providerId: account.providerId,
              githubLogin: account.githubLogin,
              avatarUrl: account.avatarUrl,
              reauthRequiredAt: account.reauthRequiredAt,
            })
            .from(account)
            .where(inArray(account.id, [...accountIds]))
            .all()
        : [];
    const accountRows: AccountCtx[] = [];
    const accountsMarkedForReauth = new Set<string>();
    for (const meta of accountMetaRows) {
      const token = yield* tokenProvider
        .getTokenByAccountId(meta.id)
        .pipe(Effect.orElseSucceed(() => null));
      // Reconcile: a client that reconnected after missing the live envelope
      // learns it still needs to re-auth. Broadcast-only (no DB re-stamp)
      // since the row already carries the flag.
      if (meta.reauthRequiredAt) {
        accountsMarkedForReauth.add(meta.id);
      } else if (knownBadTokensByAccountId.has(meta.id)) {
        // Reconcile the in-memory pause with the persistent reauth gate.
        // `knownBadTokensByAccountId` only self-clears when the token *value*
        // rotates, but the DB flag clears whenever the token is proven good —
        // on re-auth, on the `/api/user/identity` probe, or in
        // `handleAuthError`'s own re-check. A *transient* 401 (GHE rate-limit /
        // SSO / gateway) pauses a still-valid token here without rotating it,
        // so without this the account would stay skipped every cycle until a
        // server restart. DB flag clear + still-paused ⇒ the in-memory entry
        // is stale: evict it so this cycle re-validates the live token instead
        // of trusting the guard.
        knownBadTokensByAccountId.delete(meta.id);
      }
      if (meta.reauthRequiredAt && !token) {
        yield* broadcaster
          .broadcastToAccount(meta.id, {
            type: "auth:reauth-required",
            data: {
              host: extractHostFromProviderId(meta.providerId),
              githubLogin: meta.githubLogin,
            },
          })
          .pipe(Effect.orElseSucceed(() => undefined));
      }
      accountRows.push({
        id: meta.id,
        userId: meta.userId,
        host: extractHostFromProviderId(meta.providerId),
        accessToken: token,
        githubLogin: meta.githubLogin,
        avatarUrl: meta.avatarUrl,
      });
    }
    const accountById = new Map(accountRows.map((a) => [a.id, a]));
    // Accounts whose token was already refreshed this cycle — bounds the
    // reactive 401 path to one refresh attempt per account per cycle.
    const refreshedThisCycle = new Set<string>();

    // First-time-only log when a token is observed to 401; subsequent calls in
    // this or future cycles are silent until the token rotates. "Needs
    // re-auth" is more useful than spamming the raw `Invalid or expired GitHub
    // token` error on every repo every cycle.
    const markTokenBad = (acc: AccountCtx): void => {
      if (!acc.accessToken) return;
      if (knownBadTokensByAccountId.get(acc.id) === acc.accessToken) return;
      knownBadTokensByAccountId.set(acc.id, acc.accessToken);
      logError(
        "PollScheduler",
        `Account ${acc.githubLogin ?? acc.id} returned 401 — pausing GitHub sync for this account until it is re-authenticated.`,
      );
    };

    const markRateLimited = (acc: AccountCtx, err: GitHubRateLimitError): void => {
      const now = Date.now();
      const resetAt = err.resetAt.getTime();
      const retryAfterMs = err.retryAfter === undefined ? 0 : err.retryAfter * 1000;
      const until = Math.max(
        Number.isFinite(resetAt) ? resetAt : 0,
        now + retryAfterMs,
        now + 60_000,
      );
      const scope = pauseScopeOf(err);
      let byScope = rateLimitedUntilByAccountId.get(acc.id);
      if (!byScope) {
        byScope = new Map();
        rateLimitedUntilByAccountId.set(acc.id, byScope);
      }
      const existingUntil = byScope.get(scope);
      byScope.set(scope, Math.max(existingUntil ?? 0, until));
      if (existingUntil !== undefined && existingUntil > now) return;
      const what =
        scope === "all" ? "GitHub sync" : `GitHub ${scope === "core" ? "REST" : scope} calls`;
      logError(
        "PollScheduler",
        `Account ${acc.githubLogin ?? acc.id} hit GitHub ${err.kind ?? "unknown"} rate limit (${err.resource ?? "unknown resource"}) — pausing ${what} for this account until ${new Date(until).toISOString()}.`,
      );
    };

    const isPausedFor = (accountId: string, scope: PauseScope): boolean => {
      const byScope = rateLimitedUntilByAccountId.get(accountId);
      const until = byScope?.get(scope);
      if (byScope === undefined || until === undefined) return false;
      if (Date.now() < until) return true;
      byScope.delete(scope);
      return false;
    };

    const liveAccount: SyncCycle["liveAccount"] = (acc, budget) => {
      if (!acc?.accessToken) return null;
      if (knownBadTokensByAccountId.get(acc.id) === acc.accessToken) return null;
      if (isPausedFor(acc.id, "all")) return null;
      if (budget !== undefined && isPausedFor(acc.id, budget)) return null;
      return { acc, token: acc.accessToken };
    };

    const liveAccountForRepo: SyncCycle["liveAccountForRepo"] = (repoId, budget) => {
      const accId = repoToAccountId.get(repoId);
      if (!accId) return null;
      return liveAccount(accountById.get(accId), budget);
    };

    // On a 401, try once to silently refresh the account's token; if it
    // rotates, update the in-memory ctx so later calls this cycle use it and
    // the account is NOT paused. If refresh is impossible/failed, pause the
    // account and stamp+broadcast the re-auth requirement.
    const handleAuthError = (acc: AccountCtx): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!acc.accessToken) return;
        if (refreshedThisCycle.has(acc.id)) return; // already attempted this cycle
        refreshedThisCycle.add(acc.id);
        const refreshed = yield* tokenProvider.refreshAccountToken(acc.id).pipe(
          Effect.map((t): string | null => t),
          Effect.orElseSucceed(() => null),
        );
        if (refreshed) {
          const cur = accountById.get(acc.id);
          if (cur) accountById.set(acc.id, { ...cur, accessToken: refreshed });
          knownBadTokensByAccountId.delete(acc.id);
          return;
        }

        const tokenStillValid = yield* githubFetch(
          "/user",
          acc.accessToken,
          apiBaseForHost(acc.host),
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (tokenStillValid) {
          yield* tokenProvider
            .clearReauthRequired(acc.id)
            .pipe(Effect.orElseSucceed(() => undefined));
          knownBadTokensByAccountId.delete(acc.id);
          return;
        }

        markTokenBad(acc);
        yield* tokenProvider.markReauthRequired(acc.id);
      });

    const clearStaleReauth = (acc: AccountCtx): Effect.Effect<void> => {
      if (!accountsMarkedForReauth.has(acc.id)) return Effect.void;
      return tokenProvider.clearReauthRequired(acc.id).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            accountsMarkedForReauth.delete(acc.id);
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      );
    };

    const tryGuarded: SyncCycle["tryGuarded"] = (acc, eff, opts) =>
      eff.pipe(
        Effect.tap(() => clearStaleReauth(acc)),
        Effect.tapError((err) => {
          if (err instanceof GitHubAuthError) return handleAuthError(acc);
          if (err instanceof GitHubRateLimitError) {
            return Effect.sync(() => {
              markRateLimited(acc, err);
            });
          }
          if (err instanceof GitHubAccessDeniedError) {
            return Effect.sync(() => {
              if (opts?.errorLabel) {
                debug("PollScheduler", `${opts.errorLabel}: ${err.message}`);
              }
            });
          }
          return Effect.sync(() => {
            if (opts?.errorLabel) {
              logError("PollScheduler", `${opts.errorLabel}:`, err);
            }
          });
        }),
        Effect.catchAll(() => Effect.succeed(null)),
      );

    return {
      repoToAccountId,
      accountRows,
      accountById,
      liveAccount,
      liveAccountForRepo,
      tryGuarded,
    };
  });
