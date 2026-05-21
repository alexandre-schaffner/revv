import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { remoteUsers } from "../db/schema/remote-users";
import { DbService } from "./Db";

// ── Service definition ───────────────────────────────────────────────────────

export class RemoteUserService extends Context.Tag("RemoteUserService")<
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
     * Fetch an image from a URL and return as base64 data URL.
     * Does not store in the database — caller should combine with upsert.
     */
    readonly fetchAsDataUrl: (url: string) => Effect.Effect<string>;
  }
>() {}

const AVATAR_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const RemoteUserServiceLive = Layer.effect(
  RemoteUserService,
  Effect.gen(function* () {
    const { db } = yield* DbService;

    function fetchImageAsDataUrl(url: string): Promise<string> {
      return fetch(url).then(async (resp) => {
        if (!resp.ok) throw new Error(`Failed to fetch avatar: ${resp.status}`);
        const contentType = resp.headers.get("content-type") ?? "image/png";
        const buf = Buffer.from(await resp.arrayBuffer());
        const base64 = buf.toString("base64");
        return `data:${contentType};base64,${base64}`;
      });
    }

    return {
      upsert: (params) =>
        Effect.tryPromise(async () => {
          const now = new Date();

          // Always lookup by (provider, login) — it's the only identifier
          // available from all callers (auth has numeric ID, but PR/comment
          // sync only has login).
          const existing = await db
            .select()
            .from(remoteUsers)
            .where(
              and(eq(remoteUsers.provider, params.provider), eq(remoteUsers.login, params.login)),
            )
            .get();

          // Determine if we need to fetch the avatar.
          let avatarContent: string | null = existing?.avatarContent ?? null;
          const shouldFetch =
            params.avatarUrl &&
            (!existing?.lastFetchedAt ||
              now.getTime() - existing.lastFetchedAt.getTime() > AVATAR_TTL_MS ||
              existing.lastAvatarUrl !== params.avatarUrl);

          if (shouldFetch && params.avatarUrl) {
            try {
              avatarContent = await fetchImageAsDataUrl(params.avatarUrl);
            } catch {
              // Keep existing cached avatar if fetch fails.
            }
          }

          const userId = existing?.id ?? crypto.randomUUID();

          await db
            .insert(remoteUsers)
            .values({
              id: userId,
              provider: params.provider,
              providerUserId: params.providerUserId,
              login: params.login,
              displayName: params.displayName ?? existing?.displayName ?? null,
              avatarContent,
              lastFetchedAt: shouldFetch && avatarContent ? now : (existing?.lastFetchedAt ?? null),
              lastAvatarUrl: params.avatarUrl ?? existing?.lastAvatarUrl ?? null,
            })
            .onConflictDoUpdate({
              target: [remoteUsers.provider, remoteUsers.login],
              set: {
                providerUserId: sql`excluded.provider_user_id`,
                login: sql`excluded.login`,
                displayName: sql`excluded.display_name`,
                avatarContent:
                  avatarContent !== null ? sql`excluded.avatar_content` : remoteUsers.avatarContent,
                lastFetchedAt: shouldFetch && avatarContent ? now : remoteUsers.lastFetchedAt,
                lastAvatarUrl: sql`excluded.last_avatar_url`,
              },
            });
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

      fetchAsDataUrl: (url) =>
        Effect.tryPromise(() => fetchImageAsDataUrl(url)).pipe(Effect.orElseSucceed(() => "")),
    };
  }),
);
