import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { serverEnv } from "./config";
import { AUTH_TRUSTED_ORIGINS } from "./http-origins";
import { appDataDir } from "./paths";
import { appDatabase } from "./services/Db";

/**
 * Locate (or create) the better-auth signing secret.
 *
 * Priority:
 *   1. `BETTER_AUTH_SECRET` env var (escape hatch for dev / CI / containers).
 *   2. Persisted key file under the OS-appropriate per-user support dir.
 *      Generated with `crypto.randomBytes(32).toString('hex')` on first run,
 *      stored mode `0600` inside a directory created mode `0700`.
 *
 * The key never leaves the machine and is not exposed to the frontend — it
 * signs session cookies and JWTs only.
 */
function loadOrCreateAuthSecret(): string {
  if (serverEnv.betterAuthSecret) return serverEnv.betterAuthSecret;

  const keyPath = authKeyPath();
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (existing.length > 0) return existing;
  }

  const dir = dirname(keyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const secret = randomBytes(32).toString("hex");
  writeFileSync(keyPath, secret, { mode: 0o600 });
  return secret;
}

/** OS-appropriate path for the persisted better-auth key. */
function authKeyPath(): string {
  return join(appDataDir(), "auth.key");
}

export const auth = betterAuth({
  baseURL: `http://localhost:${serverEnv.port}`,
  secret: loadOrCreateAuthSecret(),
  database: drizzleAdapter(appDatabase(), {
    provider: "sqlite",
  }),
  // No `socialProviders` — Revv authenticates exclusively via GitHub's
  // device-code flow (see `routes/device-auth.ts`). The browser-redirect
  // social provider was never wired up on the frontend and required
  // `client_secret`, which we no longer collect.
  plugins: [bearer()],
  trustedOrigins: [...AUTH_TRUSTED_ORIGINS],
  account: {
    // Store OAuth state entirely in an encrypted cookie instead of DB + signed-cookie.
    // This avoids cross-origin cookie mismatch errors when the sign-in fetch originates
    // from localhost:5173 but the callback lands on localhost:45678.
    storeStateStrategy: "cookie",
  },
});
