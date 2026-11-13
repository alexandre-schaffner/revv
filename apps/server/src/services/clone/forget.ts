// Forgetting a repository, an account or a whole local user: one operation.
// The rows cascade (repository → pull requests → threads, walkthroughs, …;
// account → external-agent credentials), but nothing on disk does, so every
// path removes what Revv wrote there first: a clone, its worktrees, holder
// folder and `revv/*` branches, or an agent's Revv install holding the
// account's token, left behind have no row any later cleanup could find them
// by. A job working in a removed worktree fails as it would after any
// repository delete.

import { inArray } from "drizzle-orm";
import { Effect } from "effect";
import { repositories } from "../../db/schema";
import { dbTry } from "../../effects/db-try";
import { DbService } from "../Db";
import { ExternalIntegrations } from "../ExternalIntegrations";
import { GitHubAccounts } from "../github/accounts";
import { RepoCloneService } from "./RepoClone";

/** Remove each repository's clone and worktrees, then its row. */
export const forgetRepositories = (repoIds: readonly string[]) =>
  Effect.gen(function* () {
    if (repoIds.length === 0) return;
    const clones = yield* RepoCloneService;
    const { db } = yield* DbService;
    for (const id of repoIds) yield* clones.deleteClone(id);
    yield* dbTry("forget repositories", () =>
      db
        .delete(repositories)
        .where(inArray(repositories.id, [...repoIds]))
        .run(),
    );
  });

const forgetRepositoriesOf = (accountIds: readonly string[]) =>
  Effect.gen(function* () {
    if (accountIds.length === 0) return;
    const { db } = yield* DbService;
    const repoIds = yield* dbTry("read the accounts' repositories", () =>
      db
        .select({ id: repositories.id })
        .from(repositories)
        .where(inArray(repositories.accountId, [...accountIds]))
        .all()
        .map((r) => r.id),
    );
    yield* forgetRepositories(repoIds);
  });

/** Remove the accounts' agent installs, then their repositories. */
const forgetOnDisk = (accountIds: readonly string[]) =>
  Effect.gen(function* () {
    const integrations = yield* ExternalIntegrations;
    for (const id of accountIds) yield* integrations.uninstallAccount(id);
    yield* forgetRepositoriesOf(accountIds);
  });

/** Forget the user's account on `host`, its agent installs and every repository it tracks. */
export const forgetAccount = (userId: string, host: string) =>
  Effect.gen(function* () {
    const accounts = yield* GitHubAccounts;
    yield* forgetOnDisk(yield* accounts.accountsOf(userId, host));
    yield* accounts.disconnect(userId, host);
  });

/** Forget the local user, their accounts, those accounts' agent installs and repositories. */
export const forgetUser = (userId: string) =>
  Effect.gen(function* () {
    const accounts = yield* GitHubAccounts;
    yield* forgetOnDisk(yield* accounts.accountsOf(userId));
    yield* accounts.removeUser(userId);
  });
