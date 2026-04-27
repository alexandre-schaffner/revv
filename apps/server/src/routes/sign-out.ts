import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { auth, db } from "../auth";
import { account } from "../db/schema";
import { logError } from "../logger";
import { withAuth } from "./middleware";

/**
 * Signs the user out locally.
 *
 * Flow:
 * 1. Clear the stored GitHub access/refresh tokens in the local `account`
 *    row for this user.
 * 2. Invalidate the better-auth session.
 *
 * We deliberately do *not* call GitHub's token revocation endpoint
 * (`DELETE /applications/{client_id}/token`) because that endpoint requires
 * HTTP Basic auth with the OAuth App's client_secret, and we no longer
 * collect a client_secret (the app authenticates exclusively via the
 * device-code flow, which doesn't need one).
 *
 * Users who want to revoke Revv's authorization on GitHub's side can do so
 * at https://github.com/settings/connections/applications/<client_id>. The
 * settings UI exposes this link.
 *
 * The client should call this instead of the default authClient.signOut().
 */
export const signOutRoute = new Elysia()
  .use(withAuth)
  .post("/api/auth/revoke-and-sign-out", async (ctx) => {
    const userId = ctx.session.user.id;

    // 1. Clear the token from the local account table so it isn't
    //    usable if the database is copied off the machine.
    let hadToken = false;
    try {
      const rows = await db
        .select()
        .from(account)
        .where(eq(account.userId, userId));
      hadToken = rows.some((r) => !!r.accessToken);
      await db
        .update(account)
        .set({ accessToken: null, refreshToken: null })
        .where(eq(account.userId, userId));
    } catch (e) {
      logError("sign-out", "Failed to clear account tokens:", e);
    }

    // 2. Invalidate the better-auth session
    try {
      await auth.api.signOut({ headers: ctx.request.headers });
    } catch {
      // Session may already be expired — proceed
    }

    // `revoked: false` is a bit of a misnomer post-change (we don't revoke
    // on GitHub any more), but the old shape is kept so the client doesn't
    // need changes. It now means "a token existed locally and has been
    // cleared".
    return { revoked: hadToken };
  });
