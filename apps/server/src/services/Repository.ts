import type { Repository } from "@revv/shared";
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Db } from "../db/index";
import { repositories } from "../db/schema/index";
import { avatarOfHostLogin } from "../db/schema/remote-users";
import { type DbError, NotFoundError, ValidationError } from "../domain/errors";
import { isPublicGitHub } from "../domain/github-host";
import { tryDb } from "../effects/db-try";
import { DbService } from "./Db";

function readRepo(db: Db, id: string) {
  return db.select(repoColumns).from(repositories).where(eq(repositories.id, id)).get();
}

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
    readonly listRepos: (accountId?: string) => Effect.Effect<Repository[], never, DbService>;
    readonly addRepo: (
      data: AddRepoData,
      accountId: string,
    ) => Effect.Effect<Repository, ValidationError, DbService>;
    readonly deleteRepo: (
      id: string,
      accountId: string,
    ) => Effect.Effect<void, NotFoundError, DbService>;
    readonly getRepoById: (
      id: string,
      accountId?: string,
    ) => Effect.Effect<Repository, NotFoundError, DbService>;
    readonly getRepoByFullName: (
      fullName: string,
      accountId: string,
    ) => Effect.Effect<Repository | null, never, DbService>;
    readonly getAccountIdForRepo: (
      repoId: string,
    ) => Effect.Effect<string, NotFoundError, DbService>;
    /** The owning account of every tracked repository, by repository id. */
    readonly accountIdsByRepo: () => Effect.Effect<Map<string, string>, DbError, DbService>;
    readonly updateRepoMetadata: (
      id: string,
      data: { readonly avatarUrl?: string | null; readonly defaultBranch?: string },
      accountId?: string,
    ) => Effect.Effect<Repository, NotFoundError, DbService>;
  }
>()("RepositoryService") {}

export const RepositoryServiceLive = Layer.succeed(RepositoryService, {
  listRepos: (accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = accountId
        ? db
            .select(repoColumns)
            .from(repositories)
            .where(eq(repositories.accountId, accountId))
            .all()
        : db.select(repoColumns).from(repositories).all();
      return rows.map(rowToRepo);
    }),

  addRepo: (data, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const id = crypto.randomUUID();
      const addedAt = new Date().toISOString();
      const row = {
        id,
        provider: data.provider,
        owner: data.owner,
        name: data.name,
        fullName: data.fullName,
        defaultBranch: data.defaultBranch,
        avatarUrl: data.avatarUrl,
        addedAt,
        githubHost: data.githubHost,
        managed: data.managed ?? true,
        cloneStatus: "pending",
        clonePath: data.clonePath ?? null,
        cloneError: null,
        accountId,
      } satisfies typeof repositories.$inferInsert;
      const saved = yield* Effect.try({
        try: () =>
          db
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
            .get(),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
      const stored = readRepo(db, saved.id);
      if (!stored)
        return yield* Effect.fail(new ValidationError({ message: "repository not saved" }));
      return rowToRepo(stored);
    }),

  deleteRepo: (id, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const existing = db.select().from(repositories).where(eq(repositories.id, id)).get();
      if (!existing || existing.accountId !== accountId) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      }
      // Use orDie so DB errors become defects, keeping the error channel as NotFoundError
      yield* Effect.try({
        try: () => db.delete(repositories).where(eq(repositories.id, id)).run(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);
    }),

  getRepoById: (id, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const found = readRepo(db, id);
      if (!found || (accountId && found.row.accountId !== accountId)) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      }
      return rowToRepo(found);
    }),

  getRepoByFullName: (fullName, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      // Scope on both columns: `(full_name, account_id)` is the unique index,
      // so the same repo can legitimately be tracked by several accounts.
      // Filtering on `full_name` alone returns an arbitrary account's row.
      const row = db
        .select(repoColumns)
        .from(repositories)
        .where(and(eq(repositories.fullName, fullName), eq(repositories.accountId, accountId)))
        .get();
      if (!row) return null;
      return rowToRepo(row);
    }),

  getAccountIdForRepo: (repoId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({ accountId: repositories.accountId })
        .from(repositories)
        .where(eq(repositories.id, repoId))
        .get();
      if (!row) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id: repoId }));
      }
      return row.accountId;
    }),

  accountIdsByRepo: () =>
    tryDb("read repository owners", (db) =>
      db
        .select({ id: repositories.id, accountId: repositories.accountId })
        .from(repositories)
        .all(),
    ).pipe(Effect.map((rows) => new Map(rows.map((r) => [r.id, r.accountId])))),

  updateRepoMetadata: (id, data, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const existing = db.select().from(repositories).where(eq(repositories.id, id)).get();
      if (!existing) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      }
      if (accountId && existing.accountId !== accountId) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      }
      const updates: Partial<typeof repositories.$inferInsert> = {};
      if (data.defaultBranch !== undefined) updates.defaultBranch = data.defaultBranch;
      if (data.avatarUrl !== undefined) updates.avatarUrl = data.avatarUrl;
      if (Object.keys(updates).length > 0) {
        yield* Effect.try({
          try: () => db.update(repositories).set(updates).where(eq(repositories.id, id)).run(),
          catch: (e) => new Error(String(e)),
        }).pipe(Effect.orDie);
      }
      const updated = readRepo(db, id);
      if (!updated) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      }
      return rowToRepo(updated);
    }),
});
