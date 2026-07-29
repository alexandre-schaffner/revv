import type { Repository } from "@revv/shared";
import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { repositories } from "../db/schema/index";
import { NotFoundError, ValidationError } from "../domain/errors";
import { DbService } from "./Db";

/**
 * Fetch an image URL and return it as a base64 data URL, or null on any
 * failure. Used to cache owner avatars locally so the client never depends on
 * an expiring signed `avatar_url`.
 */
async function fetchAvatarAsDataUrl(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") ?? "image/png";
    const base64 = Buffer.from(await resp.arrayBuffer()).toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

function rowToRepo(row: typeof repositories.$inferSelect): Repository {
  return {
    id: row.id,
    provider: row.provider,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    // Prefer the cached data URL — it never expires. Fall back to the raw
    // (possibly signed/expiring) URL, then to the GitHub default-by-owner URL.
    avatarUrl:
      row.avatarContent ??
      row.avatarUrl ??
      (row.provider === "github" ? `https://avatars.githubusercontent.com/${row.owner}` : null),
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

export class RepositoryService extends Context.Tag("RepositoryService")<
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
    readonly updateRepoMetadata: (
      id: string,
      data: { readonly avatarUrl?: string | null; readonly defaultBranch?: string },
      accountId?: string,
    ) => Effect.Effect<Repository, NotFoundError, DbService>;
  }
>() {}

export const RepositoryServiceLive = Layer.succeed(RepositoryService, {
  listRepos: (accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = accountId
        ? db.select().from(repositories).where(eq(repositories.accountId, accountId)).all()
        : db.select().from(repositories).all();
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
                avatarContent: sql`CASE WHEN ${repositories.avatarUrl} IS NOT excluded.avatar_url THEN NULL ELSE ${repositories.avatarContent} END`,
                addedAt: sql`excluded.added_at`,
                githubHost: sql`excluded.github_host`,
                managed: sql`excluded.managed`,
                cloneStatus: sql`excluded.clone_status`,
                clonePath: sql`excluded.clone_path`,
                cloneError: sql`excluded.clone_error`,
              },
            })
            .returning()
            .get(),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
      return rowToRepo(saved);
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
      const row = db.select().from(repositories).where(eq(repositories.id, id)).get();
      if (!row) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      }
      if (accountId && row.accountId !== accountId) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      }
      return rowToRepo(row);
    }),

  getRepoByFullName: (fullName, accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db.select().from(repositories).where(eq(repositories.fullName, fullName)).get();
      if (!row || row.accountId !== accountId) return null;
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

      // Re-fetch the avatar bytes when the raw URL changed (GitHub Enterprise
      // signed URLs rotate hourly) or when we never cached them. The fetch is
      // best-effort: on failure we keep whatever is already cached so a
      // transient network blip never blanks the icon.
      if (data.avatarUrl !== undefined && data.avatarUrl !== existing.avatarUrl) {
        updates.avatarUrl = data.avatarUrl;
      }
      const rawUrl = data.avatarUrl !== undefined ? data.avatarUrl : existing.avatarUrl;
      const urlChanged = data.avatarUrl !== undefined && data.avatarUrl !== existing.avatarUrl;
      if (rawUrl && (urlChanged || existing.avatarContent == null)) {
        const fetched = yield* Effect.promise(() => fetchAvatarAsDataUrl(rawUrl));
        if (fetched !== null && fetched !== existing.avatarContent) {
          updates.avatarContent = fetched;
        }
      }

      if (Object.keys(updates).length === 0) {
        return rowToRepo(existing);
      }
      yield* Effect.try({
        try: () => db.update(repositories).set(updates).where(eq(repositories.id, id)).run(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);
      const updated = db.select().from(repositories).where(eq(repositories.id, id)).get();
      if (!updated) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      }
      return rowToRepo(updated);
    }),
});
