/**
 * Compare two provider logins. GitHub logins are case-insensitive, so `"Alex"`
 * and `"alex"` are the same account; either being absent is never a match.
 */
export function loginsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** The signed-in local user and the GitHub account the request acts as (the active host's). */
export interface UserIdentity {
  id: string;
  name: string;
  email: string;
  /** The active account's own GitHub login: who "me" is on that host. */
  login: string | null;
  /**
   * Base64 data URL resolved from `remote_users`: GitHub Enterprise avatar
   * URLs are signed and expire, so the raw URL is never sent.
   */
  avatarContent: string | null;
  /**
   * `true` when the signed-in user's GitHub login is on the project
   * maintainer allowlist (`MAINTAINER_LOGINS`). Maintainers see new updates
   * the moment CI publishes them — the 48h stable cooldown is bypassed.
   */
  isMaintainer: boolean;
  /**
   * `true` when the active account's GitHub token is invalid and could not be
   * silently refreshed — the client gates the app behind a re-sign-in modal.
   * Authoritative reconcile source for `auth:reauth-required` SSE signals on
   * boot / SSE reconnect. `host` is the account's GitHub host, used to drive
   * the re-auth device flow against the right instance.
   */
  reauthRequired: boolean;
  host: string | null;
  /** ISO time the user finished onboarding, or null. */
  onboardedAt: string | null;
}

export interface Team {
  /** GitHub team slug — unique within the org, used as the stable key. */
  slug: string;
  name: string;
  /**
   * Read through GraphQL, capped at the first 100 members per team (and the
   * first 100 teams per org); see `teamsForOrg`.
   */
  memberLogins: string[];
}
