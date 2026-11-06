import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { remoteUsers } from "../../db/schema/remote-users";
import { dbTry } from "../../effects/db-try";
import { logError } from "../../logger";
import { DbService } from "../Db";
import { fetchDataUrl } from "./transport";

/**
 * The avatar of everyone Revv shows — PR authors, commenters, repo owners,
 * signed-in users — cached as bytes per (host, login). The rendered value is
 * always the cached data URL: GitHub Enterprise avatar URLs are signed and
 * expire, so a URL is only ever a source to fetch from.
 */
export class AvatarCache extends Context.Service<
  AvatarCache,
  {
    /**
     * Cache `login`'s avatar from `url`. Fetches only when the image named by
     * the URL changed or the cached copy is older than a day; a failed fetch
     * keeps the cached bytes. Returns the row id and whether the bytes changed.
     */
    readonly ensure: (
      host: string,
      login: string,
      url: string | null | undefined,
      options?: { readonly displayName?: string | null },
    ) => Effect.Effect<{ readonly id: string | null; readonly changed: boolean }>;
    /** Cached avatars of `logins` on `host`; logins without one are absent. */
    readonly contents: (
      host: string,
      logins: Iterable<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>>;
  }
>()("AvatarCache") {}

const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;

// Avatars render at most ~40px (≈80px @2x), but GitHub serves full resolution
// by default (50KB average, 450KB max measured). The data URL rides along in
// every PR row, so ask for a small fixed size (~5KB).
const AVATAR_FETCH_SIZE = 96;

/**
 * Which image an avatar URL names: its host and path (`/u/<id>`). The query
 * isn't part of it: GraphQL and REST spell the same avatar differently
 * (`?u=<hash>&v=4` vs `?v=4`), and GitHub Enterprise signs it afresh on every
 * answer.
 */
export function avatarIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** GitHub and Gravatar honour `?s=`; other hosts ignore it. */
function sizedAvatarUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("s", String(AVATAR_FETCH_SIZE));
    return u.toString();
  } catch {
    return url;
  }
}

export const AvatarCacheLive = Layer.effect(
  AvatarCache,
  Effect.gen(function* () {
    const { db } = yield* DbService;

    const find = (host: string, login: string) =>
      dbTry("read avatar", () =>
        db
          .select()
          .from(remoteUsers)
          .where(
            and(
              eq(remoteUsers.provider, "github"),
              eq(remoteUsers.host, host),
              eq(remoteUsers.login, login),
            ),
          )
          .get(),
      );

    const ensure = (
      host: string,
      login: string,
      url: string | null | undefined,
      options: { readonly displayName?: string | null } = {},
    ) =>
      Effect.gen(function* () {
        const now = new Date();
        const existing = yield* find(host, login);
        const target = url ? sizedAvatarUrl(url) : null;
        const due =
          target !== null &&
          (!existing?.lastFetchedAt ||
            existing.avatarContent === null ||
            now.getTime() - existing.lastFetchedAt.getTime() > AVATAR_TTL_MS ||
            avatarIdentity(existing.lastAvatarUrl) !== avatarIdentity(target));
        const fetched =
          due && target !== null
            ? yield* fetchDataUrl(target).pipe(
                Effect.catch((e) =>
                  Effect.sync(() => {
                    logError("avatars", `avatar fetch failed for ${login}@${host}:`, e);
                    return null;
                  }),
                ),
              )
            : null;
        const displayName = options.displayName ?? existing?.displayName ?? null;
        const changed = fetched !== null && fetched !== existing?.avatarContent;

        if (existing) {
          if (fetched === null && displayName === existing.displayName) {
            return { id: existing.id, changed: false };
          }
          yield* dbTry("update avatar", () =>
            db
              .update(remoteUsers)
              .set({
                displayName,
                ...(fetched !== null
                  ? { avatarContent: fetched, lastFetchedAt: now, lastAvatarUrl: target }
                  : {}),
              })
              .where(eq(remoteUsers.id, existing.id))
              .run(),
          );
          return { id: existing.id, changed };
        }

        const id = crypto.randomUUID();
        yield* dbTry("insert avatar", () =>
          db
            .insert(remoteUsers)
            .values({
              id,
              provider: "github",
              providerUserId: "",
              host,
              login,
              displayName,
              avatarContent: fetched,
              lastFetchedAt: fetched !== null ? now : null,
              lastAvatarUrl: fetched !== null ? target : null,
            })
            .onConflictDoNothing()
            .run(),
        );
        const row = existing ?? (yield* find(host, login));
        return { id: row?.id ?? id, changed };
      }).pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            logError("avatars", `caching avatar for ${login}@${host} failed:`, e.message);
            return { id: null, changed: false };
          }),
        ),
      );

    const contents = (host: string, logins: Iterable<string>) => {
      const wanted = [...new Set(logins)];
      if (wanted.length === 0) return Effect.succeed(new Map<string, string>());
      return dbTry("read avatars", () =>
        db
          .select({ login: remoteUsers.login, avatarContent: remoteUsers.avatarContent })
          .from(remoteUsers)
          .where(
            and(
              eq(remoteUsers.provider, "github"),
              eq(remoteUsers.host, host),
              inArray(remoteUsers.login, wanted),
              isNotNull(remoteUsers.avatarContent),
            ),
          )
          .all(),
      ).pipe(
        Effect.map(
          (rows) =>
            new Map(
              rows.flatMap((row) =>
                row.avatarContent ? [[row.login, row.avatarContent] as const] : [],
              ),
            ),
        ),
        Effect.catch((e) =>
          Effect.sync(() => {
            logError("avatars", e.message);
            return new Map<string, string>();
          }),
        ),
      );
    };

    return { ensure, contents };
  }),
);
