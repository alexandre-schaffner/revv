import type { Repository } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { repositories } from "../db/schema/index";
import { NotFoundError, ValidationError } from "../domain/errors";
import { DbService } from "./Db";

function rowToRepo(row: typeof repositories.$inferSelect): Repository {
  return {
    id: row.id,
    provider: row.provider,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    avatarUrl:
      row.avatarUrl ??
      (row.provider === "github"
        ? `https://avatars.githubusercontent.com/${row.owner}`
        : null),
    addedAt: row.addedAt,
    cloneStatus: row.cloneStatus,
    clonePath: row.clonePath ?? null,
    cloneError: row.cloneError ?? null,
  };
}

export class RepositoryService extends Context.Tag("RepositoryService")<
  RepositoryService,
  {
    readonly listRepos: () => Effect.Effect<Repository[], never, DbService>;
    readonly addRepo: (
      data: Omit<
        Repository,
        "id" | "addedAt" | "cloneStatus" | "clonePath" | "cloneError"
      >,
    ) => Effect.Effect<Repository, ValidationError, DbService>;
    readonly deleteRepo: (
      id: string,
    ) => Effect.Effect<void, NotFoundError, DbService>;
    readonly getRepoById: (
      id: string,
    ) => Effect.Effect<Repository, NotFoundError, DbService>;
    readonly getRepoByFullName: (
      fullName: string,
    ) => Effect.Effect<Repository | null, never, DbService>;
    readonly updateRepoMetadata: (
      id: string,
      data: {
        readonly avatarUrl?: string | null;
        readonly defaultBranch?: string;
      },
    ) => Effect.Effect<Repository, NotFoundError, DbService>;
  }
>() {}

export const RepositoryServiceLive = Layer.succeed(RepositoryService, {
  listRepos: () =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = db.select().from(repositories).all();
      return rows.map(rowToRepo);
    }),

  addRepo: (data) =>
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
        ...(data.avatarUrl !== null ? { avatarUrl: data.avatarUrl } : {}),
        addedAt,
      } satisfies typeof repositories.$inferInsert;
      yield* Effect.tryPromise({
        try: () => Promise.resolve(db.insert(repositories).values(row).run()),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
      return rowToRepo({
        id,
        provider: data.provider,
        owner: data.owner,
        name: data.name,
        fullName: data.fullName,
        defaultBranch: data.defaultBranch,
        avatarUrl: data.avatarUrl ?? null,
        addedAt,
        cloneStatus: "pending",
        clonePath: null,
        cloneError: null,
      });
    }),

  deleteRepo: (id) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const existing = db
        .select()
        .from(repositories)
        .where(eq(repositories.id, id))
        .get();
      if (!existing) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "repository", id }),
        );
      }
      // Use orDie so DB errors become defects, keeping the error channel as NotFoundError
      yield* Effect.try({
        try: () => db.delete(repositories).where(eq(repositories.id, id)).run(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);
    }),

  getRepoById: (id) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select()
        .from(repositories)
        .where(eq(repositories.id, id))
        .get();
      if (!row) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "repository", id }),
        );
      }
      return rowToRepo(row);
    }),

  getRepoByFullName: (fullName) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select()
        .from(repositories)
        .where(eq(repositories.fullName, fullName))
        .get();
      return row ? rowToRepo(row) : null;
    }),

  updateRepoMetadata: (id, data) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const existing = db
        .select()
        .from(repositories)
        .where(eq(repositories.id, id))
        .get();
      if (!existing) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "repository", id }),
        );
      }
      const updates: Partial<typeof repositories.$inferInsert> = {};
      if (data.avatarUrl !== undefined) updates.avatarUrl = data.avatarUrl;
      if (data.defaultBranch !== undefined)
        updates.defaultBranch = data.defaultBranch;
      if (Object.keys(updates).length === 0) {
        return rowToRepo(existing);
      }
      yield* Effect.try({
        try: () =>
          db
            .update(repositories)
            .set(updates)
            .where(eq(repositories.id, id))
            .run(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);
      const updated = db
        .select()
        .from(repositories)
        .where(eq(repositories.id, id))
        .get();
      if (!updated) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "repository", id }),
        );
      }
      return rowToRepo(updated);
    }),
});
