import type { Repository } from "@revv/shared";
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Db } from "../db/index";
import { repositories } from "../db/schema/index";
import { avatarOfHostLogin } from "../db/schema/remote-users";
import { DbError, NotFoundError } from "../domain/errors";
import { isPublicGitHub } from "../domain/github-host";
import { tryDb } from "../effects/db-try";
import type { DbService } from "./Db";

function readRepo(db: Db, id: string) {
  return db.select(repoColumns).from(repositories).where(eq(repositories.id, id)).get();
}

const notFound = (id: string) => new NotFoundError({ resource: "repository", id });

const repoColumns = {
  row: repositories,
  ownerAvatar: avatarOfHostLogin(repositories.owner, repositories.githubHost),
};

function rowToRepo({
  row,
  ownerAvatar,
}: {
  readonly row: typeof repositories.$inferSelect;
  readonly ownerAvatar: string | null;
}): Repository {
  return {
    id: row.id,
    provider: row.provider,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    // The cached bytes, else — on github.com only, where avatar URLs aren't
    // signed — the raw URL or GitHub's by-owner URL.
    avatarUrl:
      ownerAvatar ??
      (isPublicGitHub(row.githubHost)
        ? (row.avatarUrl ?? `https://avatars.githubusercontent.com/${row.owner}`)
        : null),
    addedAt: row.addedAt,
    cloneStatus: row.cloneStatus,
    clonePath: row.clonePath ?? null,
    cloneError: row.cloneError ?? null,
    managed: row.managed,
    githubHost: row.githubHost,
  };
}

type AddRepoData = Omit<
  Repository,
  "id" | "addedAt" | "cloneStatus" | "clonePath" | "cloneError" | "managed"
> & {
  readonly managed?: boolean;
  readonly clonePath?: string | null;
};

export class RepositoryService extends Context.Service<
  RepositoryService,
  {
    readonly listRepos: (accountId?: string) => Effect.Effect<Repository[], DbError, DbService>;
    readonly addRepo: (
      data: AddRepoData,
      accountId: string,
    ) => Effect.Effect<Repository, DbError, DbService>;
    readonly deleteRepo: (
      id: string,
      accountId: string,
    ) => Effect.Effect<void, NotFoundError | DbError, DbService>;
    readonly getRepoById: (
      id: string,
      accountId?: string,
    ) => Effect.Effect<Repository, NotFoundError | DbError, DbService>;
    readonly getRepoByFullName: (
      fullName: string,
      accountId: string,
    ) => Effect.Effect<Repository | null, DbError, DbService>;
    readonly getAccountIdForRepo: (
      repoId: string,
    ) => Effect.Effect<string, NotFoundError | DbError, DbService>;
    /** The owning account of every tracked repository, by repository id. */
    readonly accountIdsByRepo: () => Effect.Effect<Map<string, string>, DbError, DbService>;
    readonly updateRepoMetadata: (
      id: string,
      data: { readonly avatarUrl?: string | null; readonly defaultBranch?: string },
    ) => Effect.Effect<Repository, NotFoundError | DbError, DbService>;
  }
>()("RepositoryService") {}

export const RepositoryServiceLive = Layer.succeed(RepositoryService, {
  listRepos: (accountId) =>
    tryDb("list repositories", (db) =>
      accountId
        ? db
            .select(repoColumns)
            .from(repositories)
            .where(eq(repositories.accountId, accountId))
            .all()
        : db.select(repoColumns).from(repositories).all(),
    ).pipe(Effect.map((rows) => rows.map(rowToRepo))),

  addRepo: (data, accountId) => {
    const row = {
      id: crypto.randomUUID(),
      provider: data.provider,
      owner: data.owner,
      name: data.name,
      fullName: data.fullName,
      defaultBranch: data.defaultBranch,
      avatarUrl: data.avatarUrl,
      addedAt: new Date().toISOString(),
      githubHost: data.githubHost,
      managed: data.managed ?? true,
      cloneStatus: "pending",
      clonePath: data.clonePath ?? null,
      cloneError: null,
      accountId,
    } satisfies typeof repositories.$inferInsert;
    return tryDb("add repository", (db) => {
      const saved = db
        .insert(repositories)
        .values(row)
        .onConflictDoUpdate({
          target: [repositories.fullName, repositories.accountId],
          set: {
            provider: sql`excluded.provider`,
            owner: sql`excluded.owner`,
            name: sql`excluded.name`,
            defaultBranch: sql`excluded.default_branch`,
            avatarUrl: sql`excluded.avatar_url`,
            addedAt: sql`excluded.added_at`,
            githubHost: sql`excluded.github_host`,
            managed: sql`excluded.managed`,
            cloneStatus: sql`excluded.clone_status`,
            clonePath: sql`excluded.clone_path`,
            cloneError: sql`excluded.clone_error`,
          },
        })
        .returning({ id: repositories.id })
        .get();
      return saved ? readRepo(db, saved.id) : undefined;
    }).pipe(
      Effect.flatMap((stored) =>
        stored
          ? Effect.succeed(rowToRepo(stored))
          : Effect.fail(new DbError({ message: "add repository: the upsert returned no row" })),
      ),
    );
  },

  deleteRepo: (id, accountId) =>
    tryDb("delete repository", (db) =>
      db
        .delete(repositories)
        .where(and(eq(repositories.id, id), eq(repositories.accountId, accountId)))
        .returning({ id: repositories.id })
        .all(),
    ).pipe(
      Effect.flatMap((deleted) => (deleted.length > 0 ? Effect.void : Effect.fail(notFound(id)))),
    ),

  getRepoById: (id, accountId) =>
    tryDb("read repository", (db) => readRepo(db, id)).pipe(
      Effect.flatMap((found) =>
        !found || (accountId && found.row.accountId !== accountId)
          ? Effect.fail(notFound(id))
          : Effect.succeed(rowToRepo(found)),
      ),
    ),

  getRepoByFullName: (fullName, accountId) =>
    // `(full_name, account_id)` is the unique index: several accounts can
    // track the same repo, so `full_name` alone matches an arbitrary row.
    tryDb("read repository by name", (db) =>
      db
        .select(repoColumns)
        .from(repositories)
        .where(and(eq(repositories.fullName, fullName), eq(repositories.accountId, accountId)))
        .get(),
    ).pipe(Effect.map((row) => (row ? rowToRepo(row) : null))),

  getAccountIdForRepo: (repoId) =>
    tryDb("read repository owner", (db) =>
      db
        .select({ accountId: repositories.accountId })
        .from(repositories)
        .where(eq(repositories.id, repoId))
        .get(),
    ).pipe(
      Effect.flatMap((row) =>
        row ? Effect.succeed(row.accountId) : Effect.fail(notFound(repoId)),
      ),
    ),

  accountIdsByRepo: () =>
    tryDb("read repository owners", (db) =>
      db
        .select({ id: repositories.id, accountId: repositories.accountId })
        .from(repositories)
        .all(),
    ).pipe(Effect.map((rows) => new Map(rows.map((r) => [r.id, r.accountId])))),

  updateRepoMetadata: (id, data) => {
    const updates: Partial<typeof repositories.$inferInsert> = {};
    if (data.defaultBranch !== undefined) updates.defaultBranch = data.defaultBranch;
    if (data.avatarUrl !== undefined) updates.avatarUrl = data.avatarUrl;
    return tryDb("update repository metadata", (db) => {
      if (Object.keys(updates).length > 0) {
        db.update(repositories).set(updates).where(eq(repositories.id, id)).run();
      }
      return readRepo(db, id);
    }).pipe(
      Effect.flatMap((updated) =>
        updated ? Effect.succeed(rowToRepo(updated)) : Effect.fail(notFound(id)),
      ),
    );
  },
});
