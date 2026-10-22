import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { remoteUsers } from "../db/schema/remote-users";
import { DbService } from "./Db";
import { githubFetchDataUrl } from "./github-rest";

// ── Service definition ───────────────────────────────────────────────────────

export class RemoteUserService extends Context.Service<
  RemoteUserService,
  {
    /**
     * Upsert a remote user profile by (provider, provider_user_id).
     * If avatarUrl is provided and differs from lastAvatarUrl (or never fetched),
     * fetches the image, converts to base64 data URL, and stores it.
     * TTL: skips fetch if last_fetched_at is within 24 hours and URL unchanged.
     */
    readonly upsert: (params: {
      provider: string;
      providerUserId: string;
      login: string;
      displayName?: string;
      avatarUrl?: string | null;
    }) => Effect.Effect<void>;

    /**
     * Get a remote user by login. Returns null if not found.
     */
    readonly getByLogin: (login: string) => Effect.Effect<{
      id: string;
      provider: string;
      providerUserId: string;
      login: string;
      displayName: string | null;
      avatarContent: string | null;
      lastFetchedAt: Date | null;
      lastAvatarUrl: string | null;
    } | null>;

    /**
     * Get avatar content (base64 data URL) for a login.
     * Returns null if user not found or no avatar cached.
     */
    readonly getAvatarContent: (login: string) => Effect.Effect<string | null>;

    /**
     * {@link getAvatarContent} for many logins in one query. Logins without a
     * cached avatar are absent from the map.
     */
    readonly getAvatarContents: (
      logins: readonly string[],
    ) => Effect.Effect<ReadonlyMap<string, string>>;

    /**
     * Fetch an image from a URL and return as base64 data URL.
     * Does not store in the database — caller should combine with upsert.
     */
    readonly fetchAsDataUrl: (url: string) => Effect.Effect<string>;
  }
>()("RemoteUserService") {}

const AVATAR_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Avatars are displayed at most ~40px (≈80px @2x) anywhere in the app, but
// GitHub serves full-resolution images by default (we measured 50KB avg,
// 450KB max). Since the base64 data URL is embedded in every PR row and
// re-decoded each time the creator-filter popover opens, an unsized avatar
// makes that popover lag on repos with many contributors. Request a small
// fixed size so the cached payload is ~5KB and decoding is instant.
const AVATAR_FETCH_SIZE = 96;

/**
 * Which image an avatar URL names: its host and path (`/u/<id>`). The query
 * isn't part of it: GraphQL and REST spell the same avatar differently
 * (`?u=<hash>&v=4` vs `?v=4`), and GitHub Enterprise signs it afresh on every
 * answer, so comparing whole URLs refetched an unchanged image each time the
 * two kinds of caller took turns. A new avatar comes in on the TTL.
 */
function avatarIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Append a size hint to a provider avatar URL (`?s=96`). GitHub/Gravatar
 * honour it; other hosts ignore the extra query param. Returns the input
 * unchanged if it isn't a parseable absolute URL.
 */
function sizedAvatarUrl(url: string, size = AVATAR_FETCH_SIZE): string {
  try {
    const u = new URL(url);
    u.searchParams.set("s", String(size));
    return u.toString();
  } catch {
    return url;
  }
}

export const RemoteUserServiceLive = Layer.effect(
  RemoteUserService,
  Effect.gen(function* () {
    const { db } = yield* DbService;

    return {
      upsert: (params) =>
        Effect.gen(function* () {
          const now = new Date();

          // Always lookup by (provider, login) — it's the only identifier
          // available from all callers (auth has numeric ID, but PR/comment
          // sync only has login).
          const existing = yield* Effect.try(() =>
            db
              .select()
              .from(remoteUsers)
              .where(
                and(eq(remoteUsers.provider, params.provider), eq(remoteUsers.login, params.login)),
              )
              .get(),
          );

          const targetAvatarUrl = params.avatarUrl ? sizedAvatarUrl(params.avatarUrl) : null;
          const shouldFetch =
            targetAvatarUrl &&
            (!existing?.lastFetchedAt ||
              now.getTime() - existing.lastFetchedAt.getTime() > AVATAR_TTL_MS ||
              avatarIdentity(existing.lastAvatarUrl) !== avatarIdentity(targetAvatarUrl));

          const fetched =
            shouldFetch && targetAvatarUrl
              ? yield* githubFetchDataUrl(targetAvatarUrl).pipe(Effect.orElseSucceed(() => null))
              : null;
          const avatarContent: string | null = fetched ?? existing?.avatarContent ?? null;

          const userId = existing?.id ?? crypto.randomUUID();

          yield* Effect.try(() =>
            db
              .insert(remoteUsers)
              .values({
                id: userId,
                provider: params.provider,
                providerUserId: params.providerUserId,
                login: params.login,
                displayName: params.displayName ?? existing?.displayName ?? null,
                avatarContent,
                lastFetchedAt:
                  shouldFetch && avatarContent ? now : (existing?.lastFetchedAt ?? null),
                lastAvatarUrl: targetAvatarUrl ?? existing?.lastAvatarUrl ?? null,
              })
              .onConflictDoUpdate({
                target: [remoteUsers.provider, remoteUsers.login],
                set: {
                  // Only overwrite the stored numeric ID when the caller actually
                  // has it — poll/sync callers pass "" and must not erase the ID
                  // that was persisted during OAuth.
                  providerUserId: sql`CASE WHEN excluded.provider_user_id != '' THEN excluded.provider_user_id ELSE ${remoteUsers.providerUserId} END`,
                  login: sql`excluded.login`,
                  displayName: sql`excluded.display_name`,
                  avatarContent:
                    avatarContent !== null
                      ? sql`excluded.avatar_content`
                      : remoteUsers.avatarContent,
                  lastFetchedAt: shouldFetch && avatarContent ? now : remoteUsers.lastFetchedAt,
                  lastAvatarUrl: sql`excluded.last_avatar_url`,
                },
              })
              .run(),
          );
        }).pipe(Effect.orElseSucceed(() => undefined)),

      getByLogin: (login) =>
        Effect.tryPromise(async () => {
          const row = await db.select().from(remoteUsers).where(eq(remoteUsers.login, login)).get();
          if (!row) return null;
          return {
            id: row.id,
            provider: row.provider,
            providerUserId: row.providerUserId,
            login: row.login,
            displayName: row.displayName ?? null,
            avatarContent: row.avatarContent ?? null,
            lastFetchedAt: row.lastFetchedAt,
            lastAvatarUrl: row.lastAvatarUrl ?? null,
          };
        }).pipe(Effect.orElseSucceed(() => null)),

      getAvatarContent: (login) =>
        Effect.tryPromise(async () => {
          const row = await db
            .select({ avatarContent: remoteUsers.avatarContent })
            .from(remoteUsers)
            .where(eq(remoteUsers.login, login))
            .get();
          return row?.avatarContent ?? null;
        }).pipe(Effect.orElseSucceed(() => null)),

      getAvatarContents: (logins) =>
        Effect.tryPromise(async () => {
          if (logins.length === 0) return new Map<string, string>();
          const rows = await db
            .select({ login: remoteUsers.login, avatarContent: remoteUsers.avatarContent })
            .from(remoteUsers)
            .where(
              and(inArray(remoteUsers.login, [...logins]), isNotNull(remoteUsers.avatarContent)),
            )
            .all();
          return new Map(
            rows.flatMap((row) =>
              row.avatarContent ? [[row.login, row.avatarContent] as const] : [],
            ),
          );
        }).pipe(Effect.orElseSucceed(() => new Map<string, string>())),

      fetchAsDataUrl: (url) => githubFetchDataUrl(url).pipe(Effect.orElseSucceed(() => "")),
    };
  }),
);
