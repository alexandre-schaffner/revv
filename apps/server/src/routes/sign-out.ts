import { Elysia } from "elysia";
import { withAuth } from "./middleware";

/**
 * Soft sign-out endpoint for multi-account mode.
 *
 * In a single-user web app it would make sense to invalidate the session and
 * revoke tokens here. Revv is a local desktop app with a different contract:
 * the user should be able to switch back to any previously-authenticated
 * account without re-doing the OAuth device-code flow. That requires keeping
 * both the DB session and the GitHub access token alive.
 *
 * This endpoint is therefore a deliberate no-op on the server side. The real
 * work happens client-side: the frontend clears its localStorage token (so
 * `isAuthenticated` becomes false) and either switches to another account or
 * navigates to the sign-in screen. Sessions expire naturally after 30 days.
 *
 * Security note: this is a local SQLite DB — the access tokens are already
 * stored in plaintext on the machine. Keeping them alive while the user is
 * "signed out" of the UI does not meaningfully change the threat model.
 *
 * A future "Remove account" action (Settings → Accounts) will perform hard
 * cleanup: revoke the GitHub token server-side and delete all DB sessions for
 * that user row.
 */
export const signOutRoute = new Elysia()
  .use(withAuth)
  .post("/api/auth/revoke-and-sign-out", async () => {
    return { revoked: false };
  });
