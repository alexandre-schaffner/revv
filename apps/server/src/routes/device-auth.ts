import { and, eq, gt, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { db, GITHUB_CLIENT_ID } from "../auth";
import { serverEnv } from "../config";
import { account, session, user } from "../db/schema";
import { remoteUsers } from "../db/schema/remote-users";
import { clientIdForHost, isPublicGitHub, tokenUrlForHost } from "../github-oauth";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { RemoteUserService } from "../services/RemoteUser";
import { SettingsService } from "../services/Settings";
import { TokenProvider } from "../services/TokenProvider";
import { withAuth } from "./middleware";

// The device-code flow needs `client_id` only — no client_secret. If the
// bundled id is missing (someone replaced it with a placeholder), warn early
// so sign-in failures are easy to diagnose.
if (
  !GITHUB_CLIENT_ID ||
  GITHUB_CLIENT_ID.startsWith("BUNDLED_") ||
  GITHUB_CLIENT_ID.startsWith("REPLACE_")
) {
  logError(
    "device-auth",
    "WARNING: GITHUB_CLIENT_ID looks like a placeholder — sign-in will fail for GHE. " +
      "Override with the GITHUB_CLIENT_ID env var or fix the bundled value in apps/server/src/config.ts",
  );
}
// GITHUB_CLIENT_ID_PUBLIC being empty is fine if the user never picks github.com —
// we warn at request time instead of boot time (see resolveGithubUrls).

const DEVICE_FLOW_SCOPE = "repo read:org user:email";

/**
 * Resolve the GitHub host at request time from user settings (set during
 * onboarding) with `config.githubHost` as the fallback for first-run
 * before the settings file has the field populated.
 *
 * `api.github.com` is the public github API hostname; GHE uses `api.<host>`.
 * Mirrors the derivation in {@link serverEnv}.
 */
async function resolveGithubUrls(hostOverride?: string): Promise<{
  host: string;
  clientId: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  userUrl: string;
  emailsUrl: string;
}> {
  const settings = await AppRuntime.runPromise(
    Effect.flatMap(SettingsService, (s) => s.getSettings()).pipe(Effect.orElseSucceed(() => null)),
  );
  const host = hostOverride?.trim() || settings?.githubHost?.trim() || serverEnv.githubHost;
  const githubBase = `https://${host}`;
  const apiBase = isPublicGitHub(host) ? "https://api.github.com" : `https://api.${host}`;
  return {
    host,
    clientId: clientIdForHost(host),
    deviceCodeUrl: `${githubBase}/login/device/code`,
    tokenUrl: tokenUrlForHost(host),
    userUrl: `${apiBase}/user`,
    emailsUrl: `${apiBase}/user/emails`,
  };
}

interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GitHubTokenResponse {
  access_token?: string;
  /**
   * Present only when the OAuth App has "Expire user authorization tokens"
   * enabled (common on GitHub Enterprise). When present, `access_token`
   * expires in `expires_in` seconds and is renewable with this refresh token
   * until `refresh_token_expires_in` seconds elapse.
   */
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  interval?: number;
}

interface ResolvedTokens {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

function resolveTokens(data: GitHubTokenResponse, now: Date): ResolvedTokens {
  return {
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? null,
    accessTokenExpiresAt: data.expires_in ? new Date(now.getTime() + data.expires_in * 1000) : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? new Date(now.getTime() + data.refresh_token_expires_in * 1000)
      : null,
  };
}

async function persistTokens(
  accountRowId: string,
  host: string,
  tokens: { accessToken: string | null; refreshToken: string | null },
): Promise<void> {
  await AppRuntime.runPromise(
    Effect.flatMap(TokenProvider, (provider) =>
      provider.storeAccountTokens(accountRowId, host, tokens),
    ),
  );
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

function generateSecureToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchGitHubUser(
  accessToken: string,
  urls: { userUrl: string },
): Promise<GitHubUser> {
  const res = await fetch(urls.userUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "Revv/1.0",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub user fetch failed: ${res.status}${body ? ` — ${body}` : ""}`);
  }
  return res.json() as Promise<GitHubUser>;
}

async function fetchPrimaryEmail(
  accessToken: string,
  urls: { emailsUrl: string },
): Promise<string | null> {
  const res = await fetch(urls.emailsUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "Revv/1.0",
    },
  });
  if (!res.ok) return null;
  const emails = (await res.json()) as GitHubEmail[];
  return emails.find((e) => e.primary)?.email ?? null;
}

async function retryFetch<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

async function upsertUserAndSession(
  tokens: ResolvedTokens,
  urls: { host: string; userUrl: string; emailsUrl: string },
): Promise<string> {
  const { accessToken } = tokens;
  const githubUser = await retryFetch(() => fetchGitHubUser(accessToken, urls), 2, 1000);
  const primaryEmail = await fetchPrimaryEmail(accessToken, urls);
  const email = primaryEmail ?? githubUser.email;

  if (!email) throw new Error("No email address found on GitHub account");

  const now = new Date();
  const accountId = githubUser.id.toString();

  // Upsert user by email
  const existingUsers = await db.select().from(user).where(eq(user.email, email));
  const existingUser = existingUsers[0];

  // Upsert the authenticated user into remote_users so their avatar is cached.
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const remoteUserService = yield* RemoteUserService;
      yield* remoteUserService.upsert({
        provider: "github",
        providerUserId: String(githubUser.id),
        login: githubUser.login,
        ...(githubUser.name ? { displayName: githubUser.name } : {}),
        avatarUrl: githubUser.avatar_url,
      });
    }).pipe(Effect.orElseSucceed(() => undefined)),
  );

  // Look up the remote_users row we just upserted.
  const remoteUser = await db
    .select({ id: remoteUsers.id })
    .from(remoteUsers)
    .where(
      and(
        eq(remoteUsers.provider, "github"),
        eq(remoteUsers.providerUserId, String(githubUser.id)),
      ),
    )
    .get();

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
    await db
      .update(user)
      .set({
        name: githubUser.name ?? githubUser.login,
        image: githubUser.avatar_url,
        githubLogin: githubUser.login,
        identityId: remoteUser?.id ?? existingUser.identityId,
        updatedAt: now,
      })
      .where(eq(user.id, userId));
  } else {
    userId = crypto.randomUUID();
    await db.insert(user).values({
      id: userId,
      name: githubUser.name ?? githubUser.login,
      email,
      emailVerified: true,
      image: githubUser.avatar_url,
      githubLogin: githubUser.login,
      identityId: remoteUser?.id ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Upsert account by providerId + accountId. Token bytes go to the secure
  // store keyed on the account row id — never the DB columns. Expiry
  // timestamps and the cleared `reauthRequiredAt` flag stay on the row.
  const providerId = `github:${urls.host}`;
  const existingAccounts = await db.select().from(account).where(eq(account.accountId, accountId));
  const existingAccount = existingAccounts.find((a) => a.providerId === providerId);
  const accountRowId = existingAccount?.id ?? crypto.randomUUID();

  if (existingAccount) {
    await db
      .update(account)
      .set({
        updatedAt: now,
        userId,
        githubLogin: githubUser.login,
        avatarUrl: githubUser.avatar_url,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        reauthRequiredAt: null,
      })
      .where(eq(account.id, accountRowId));
  } else {
    await db.insert(account).values({
      id: accountRowId,
      accountId,
      providerId,
      userId,
      githubLogin: githubUser.login,
      avatarUrl: githubUser.avatar_url,
      scope: DEVICE_FLOW_SCOPE,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  await persistTokens(accountRowId, urls.host, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });

  // Create new session
  const sessionToken = generateSecureToken();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await db.insert(session).values({
    id: crypto.randomUUID(),
    token: sessionToken,
    userId,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  return sessionToken;
}

async function upsertAccountForUser(
  tokens: ResolvedTokens,
  urls: { host: string; userUrl: string },
  userId: string,
): Promise<void> {
  const githubUser = await retryFetch(() => fetchGitHubUser(tokens.accessToken, urls), 2, 1000);
  const providerId = `github:${urls.host}`;
  const accountId = githubUser.id.toString();
  const now = new Date();

  const existing = await db
    .select()
    .from(account)
    .where(and(eq(account.providerId, providerId), eq(account.userId, userId)))
    .then((r) => r[0] ?? null);
  const accountRowId = existing?.id ?? crypto.randomUUID();

  if (existing) {
    await db
      .update(account)
      .set({
        githubLogin: githubUser.login,
        avatarUrl: githubUser.avatar_url,
        updatedAt: now,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        reauthRequiredAt: null,
      })
      .where(eq(account.id, accountRowId));
  } else {
    await db.insert(account).values({
      id: accountRowId,
      accountId,
      providerId,
      userId,
      githubLogin: githubUser.login,
      avatarUrl: githubUser.avatar_url,
      scope: DEVICE_FLOW_SCOPE,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  await persistTokens(accountRowId, urls.host, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
}

const KNOWN_HOSTS = ["nocturlab.ghe.com", "github.com"] as const;

// Public routes — no session required
const publicAuthRoutes = new Elysia()
  .get("/api/auth/local-accounts", async () => {
    const now = new Date();

    // Find all sessions that haven't expired yet
    const activeSessions = await db
      .select({ userId: session.userId })
      .from(session)
      .where(gt(session.expiresAt, now));

    const userIds = [...new Set(activeSessions.map((s) => s.userId))];
    if (userIds.length === 0) return [];

    // Fetch user rows for all active user ids
    const users = await db
      .select({ id: user.id, name: user.name, email: user.email, image: user.image })
      .from(user)
      .where(inArray(user.id, userIds));

    // Fetch account rows to extract per-host login/avatar info for each user
    const accounts = await db
      .select({
        userId: account.userId,
        providerId: account.providerId,
        githubLogin: account.githubLogin,
        avatarUrl: account.avatarUrl,
      })
      .from(account)
      .where(inArray(account.userId, userIds));

    const accountsByUserId = new Map<
      string,
      Array<{ host: string; githubLogin: string | null; avatarUrl: string | null }>
    >();
    for (const acc of accounts) {
      const host = acc.providerId.split(":")[1];
      if (!host) continue;
      const existing = accountsByUserId.get(acc.userId) ?? [];
      existing.push({
        host,
        githubLogin: acc.githubLogin ?? null,
        avatarUrl: acc.avatarUrl ?? null,
      });
      accountsByUserId.set(acc.userId, existing);
    }

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      accounts: accountsByUserId.get(u.id) ?? [],
    }));
  })
  .post(
    "/api/auth/switch",
    async (ctx) => {
      const { userId: targetUserId } = ctx.body;

      if (!targetUserId) return ctx.status(400, { error: "userId is required" });

      const now = new Date();

      // Verify the target user exists
      const targetUser = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, targetUserId))
        .then((r) => r[0] ?? null);

      if (!targetUser)
        return ctx.status(404, { error: "User not found or not set up on this machine" });

      // Verify the target user has at least one active session (set up on this machine)
      const activeSession = await db
        .select({ id: session.id })
        .from(session)
        .where(and(eq(session.userId, targetUserId), gt(session.expiresAt, now)))
        .then((r) => r[0] ?? null);

      if (!activeSession)
        return ctx.status(404, { error: "User not found or not set up on this machine" });

      // Create a new session for the target user
      const sessionToken = generateSecureToken();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

      await db.insert(session).values({
        id: crypto.randomUUID(),
        token: sessionToken,
        userId: targetUserId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });

      return { token: sessionToken };
    },
    { body: t.Object({ userId: t.String() }) },
  )
  .post(
    "/api/auth/device/init",
    async ({ body, status }) => {
      const urls = await resolveGithubUrls(body?.host);
      const res = await fetch(urls.deviceCodeUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: urls.clientId, scope: DEVICE_FLOW_SCOPE }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "(unreadable)");
        logError(
          "device-auth",
          `GitHub device code request failed: ${res.status} ${res.statusText}`,
          text,
        );
        return status(502, { error: "Failed to initiate device flow" });
      }

      const data = (await res.json()) as GitHubDeviceCodeResponse;
      return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_in: data.expires_in,
        interval: data.interval,
      };
    },
    { body: t.Optional(t.Object({ host: t.Optional(t.String()) })) },
  )
  .post(
    "/api/auth/device/poll",
    async ({ body, status }) => {
      // Check if caller already has a valid session (link-account path)
      const existingSessionToken = body.session_token ?? null;
      let existingUserId: string | null = null;
      if (existingSessionToken) {
        const sessionRow = await db
          .select()
          .from(session)
          .where(eq(session.token, existingSessionToken))
          .then((r) => r[0] ?? null);
        if (sessionRow && sessionRow.expiresAt > new Date()) {
          existingUserId = sessionRow.userId;
        }
      }

      const urls = await resolveGithubUrls(body.host);
      // Per GitHub's docs, device-flow token exchange does not take a
      // client_secret — only client_id, device_code, and grant_type.
      const res = await fetch(urls.tokenUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: urls.clientId,
          device_code: body.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      const data = (await res.json()) as GitHubTokenResponse;

      if (data.access_token && existingUserId) {
        // Link path: user is already signed in — only upsert the account row.
        // Also the re-auth path: re-signing-in the active account lands here
        // (the client sends its session_token), refreshing the stored token
        // and clearing `reauthRequiredAt` on the existing row.
        try {
          await upsertAccountForUser(resolveTokens(data, new Date()), urls, existingUserId);
          return { status: "linked" as const };
        } catch (e) {
          logError("device-auth", "account link failed:", e);
          const message = e instanceof Error ? e.message : String(e);
          return status(500, { error: `Account link failed: ${message}` });
        }
      }

      if (data.access_token) {
        try {
          const token = await upsertUserAndSession(resolveTokens(data, new Date()), urls);
          return { status: "success" as const, token };
        } catch (e) {
          logError("device-auth", "session creation failed:", e);
          const message = e instanceof Error ? e.message : String(e);
          return status(500, { error: `Session creation failed: ${message}` });
        }
      }

      if (data.error === "authorization_pending") return { status: "pending" as const };
      if (data.error === "slow_down")
        return { status: "slow_down" as const, interval: data.interval ?? 10 };
      if (data.error === "expired_token") return status(400, { error: "expired" });
      if (data.error === "access_denied") return status(400, { error: "access_denied" });

      logError("device-auth", "unexpected GitHub token response:", data);
      return status(400, { error: data.error ?? "Unknown error from GitHub" });
    },
    {
      body: t.Object({
        device_code: t.String(),
        host: t.Optional(t.String()),
        session_token: t.Optional(t.String()),
      }),
    },
  );

// Protected routes — require valid session
const protectedAuthRoutes = new Elysia()
  .use(withAuth)
  .get("/api/auth/accounts", async (ctx) => {
    const userId = ctx.session.user.id;
    return Promise.all(
      KNOWN_HOSTS.map(async (host) => {
        const providerId = `github:${host}`;
        const accountRow = await db
          .select()
          .from(account)
          .where(and(eq(account.providerId, providerId), eq(account.userId, userId)))
          .then((r) => r[0] ?? null);
        return {
          host,
          connected: accountRow !== null,
          githubLogin: accountRow?.githubLogin ?? null,
          avatarUrl: accountRow?.avatarUrl ?? null,
        };
      }),
    );
  })
  .post(
    "/api/auth/accounts/disconnect",
    async (ctx) => {
      const { host } = ctx.body;
      if (!KNOWN_HOSTS.includes(host as (typeof KNOWN_HOSTS)[number])) {
        return ctx.status(400, { error: `Unknown host: ${host}` });
      }
      const providerId = `github:${host}`;
      const userId = ctx.session.user.id;

      // We cannot revoke the grant on GitHub's side: the only OAuth flow Revv
      // uses is the device-code flow, which never collects a client secret
      // (see auth.ts), and GitHub's `DELETE /applications/{id}/token`
      // endpoint requires HTTP Basic auth with that secret. Attempting it would
      // just send an empty secret and silently 401. So disconnect is a local
      // operation: delete the account row and wipe its stored tokens. Users who
      // want to revoke the grant upstream do so from their GitHub app
      // connections page (linked from the settings UI).
      const accountRow = await db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.providerId, providerId), eq(account.userId, userId)))
        .then((r) => r[0] ?? null);

      await db
        .delete(account)
        .where(and(eq(account.providerId, providerId), eq(account.userId, userId)));
      if (accountRow) {
        await AppRuntime.runPromise(
          Effect.flatMap(TokenProvider, (provider) => provider.deleteAccountTokens(accountRow.id)),
        );
      }
      return { ok: true };
    },
    { body: t.Object({ host: t.String() }) },
  );

export const deviceAuthRoutes = new Elysia().use(publicAuthRoutes).use(protectedAuthRoutes);
