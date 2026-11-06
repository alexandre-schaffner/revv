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
 * `BETTER_AUTH_SECRET` when set, else a key generated on first run and kept
 * under the app-data dir (file `0600`, directory `0700`). It never leaves the
 * machine and never reaches the frontend: it signs session cookies and JWTs only.
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

function authKeyPath(): string {
  return join(appDataDir(), "auth.key");
}

export const auth = betterAuth({
  baseURL: `http://localhost:${serverEnv.port}`,
  secret: loadOrCreateAuthSecret(),
  database: drizzleAdapter(appDatabase(), {
    provider: "sqlite",
  }),
  // No `socialProviders`: Revv signs in only through GitHub's device-code flow
  // (`routes/device-auth.ts`), which needs no `client_secret`.
  plugins: [bearer()],
  trustedOrigins: [...AUTH_TRUSTED_ORIGINS],
  account: {
    // Store OAuth state entirely in an encrypted cookie instead of DB + signed-cookie.
    // This avoids cross-origin cookie mismatch errors when the sign-in fetch originates
    // from localhost:5173 but the callback lands on localhost:45678.
    storeStateStrategy: "cookie",
  },
});
