import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { API_PORT } from "@revv/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { serverEnv } from "./config";
import { createDb } from "./db/index";

// Re-exported for the handful of routes that still reach in directly.
// All values are sourced from the centralized `serverEnv` snapshot in
// `config.ts`, which resolves Effect's `ServerConfig` once at startup.
//
// `GITHUB_CLIENT_SECRET` is intentionally absent — the device-code flow
// (the only OAuth flow the app uses) does not require it, and sign-out no
// longer revokes on GitHub's side. Users can revoke from the GitHub app
// connections page if they want (linked from the settings UI).
export const GITHUB_CLIENT_ID = serverEnv.githubClientId;
export const GITHUB_HOST = serverEnv.githubHost;
export const GITHUB_API_BASE = serverEnv.githubApiBase;

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
  const envOverride = process.env.BETTER_AUTH_SECRET;
  if (envOverride && envOverride.length > 0) return envOverride;

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
  const home = homedir();
  const plat = platform();
  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "Revv", "auth.key");
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Revv", "auth.key");
  }
  // XDG on Linux / other POSIX.
  const xdg = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(xdg, "revv", "auth.key");
}

const db = createDb();

export { db };

export const auth = betterAuth({
  baseURL: `http://localhost:${API_PORT}`,
  secret: loadOrCreateAuthSecret(),
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  // No `socialProviders` — Revv authenticates exclusively via GitHub's
  // device-code flow (see `routes/device-auth.ts`). The browser-redirect
  // social provider was never wired up on the frontend and required
  // `client_secret`, which we no longer collect.
  plugins: [bearer()],
  trustedOrigins: [
    "http://localhost:5173",
    "tauri://localhost",
    "https://tauri.localhost",
  ],
  account: {
    // Store OAuth state entirely in an encrypted cookie instead of DB + signed-cookie.
    // This avoids cross-origin cookie mismatch errors when the sign-in fetch originates
    // from localhost:5173 but the callback lands on localhost:45678.
    storeStateStrategy: "cookie",
  },
});
