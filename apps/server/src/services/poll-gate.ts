/**
 * How a poll cycle reaches GitHub: which account owns each repo, and the one
 * way to get a client for it. `GitHubAccounts.backgroundClient` answers null
 * for an account that needs re-auth or is paused after a rate limit, so every
 * phase skips such an account the same way; the gateway reports each 401 and
 * rate limit to `GitHubAccounts` as it happens, so a pause taken mid-cycle
 * holds for the rest of it.
 */
import type { Context } from "effect";
import { Effect } from "effect";
import {
  GitHubAccessDeniedError,
  GitHubAuthError,
  type GitHubError,
  GitHubRateLimitError,
} from "../domain/errors";
import { debug, logError } from "../logger";
import type { GitHubAccounts, GitHubBudget } from "./github/accounts";
import type { GitHubClient } from "./github/transport";

export interface AccountGate {
  /** Tracked repository id → owning account id. */
  readonly repoToAccountId: ReadonlyMap<string, string>;
  readonly accountIds: readonly string[];
  /** A client for the repo's account, or null when it must not be called now. */
  readonly clientForRepo: (
    repoId: string,
    budget?: GitHubBudget,
  ) => Effect.Effect<GitHubClient | null>;
  readonly clientForAccount: (
    accountId: string,
    budget?: GitHubBudget,
  ) => Effect.Effect<GitHubClient | null>;
  /**
   * Run a GitHub call, answering null when it fails. Auth failures and rate
   * limits were already handed to `GitHubAccounts`; anything else is logged
   * under `label`.
   */
  readonly guarded: <A, R>(
    effect: Effect.Effect<A, GitHubError, R>,
    label?: string,
  ) => Effect.Effect<A | null, never, R>;
}

export const openGate = (
  accounts: Context.Service.Shape<typeof GitHubAccounts>,
  repoToAccountId: ReadonlyMap<string, string>,
): Effect.Effect<AccountGate> =>
  Effect.gen(function* () {
    const accountIds = [...new Set(repoToAccountId.values())];
    // A 401 can be transient (an SSO or gateway hiccup): once a cycle, ask
    // GitHub whether a flagged account's token works after all.
    yield* Effect.forEach(accountIds, accounts.probeFlagged, { discard: true, concurrency: 3 });

    const clientForAccount: AccountGate["clientForAccount"] = (accountId, budget) =>
      accounts.backgroundClient(accountId, budget);

    return {
      repoToAccountId,
      accountIds,
      clientForAccount,
      clientForRepo: (repoId, budget) => {
        const accountId = repoToAccountId.get(repoId);
        return accountId === undefined ? Effect.succeed(null) : clientForAccount(accountId, budget);
      },
      guarded: (effect, label) =>
        effect.pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              if (err instanceof GitHubAuthError || err instanceof GitHubRateLimitError)
                return null;
              if (label) {
                if (err instanceof GitHubAccessDeniedError)
                  debug("PollScheduler", `${label}: ${err.message}`);
                else logError("PollScheduler", `${label}:`, err);
              }
              return null;
            }),
          ),
        ),
    };
  });
