/**
 * Compare two provider logins. GitHub logins are case-insensitive, so `"Alex"`
 * and `"alex"` are the same account; either being absent is never a match.
 */
export function loginsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export type UserRole = "reviewer" | "coder" | "unknown";

export interface UserIdentity {
  login: string | null;
  role: UserRole;
  /**
   * Base64 data URL of the user's avatar (e.g. "data:image/png;base64,...").
   * Resolved from the remote_users table so expired GitHub Enterprise signed
   * URLs never cause 404s.
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
}

export interface Team {
  /** GitHub team slug — unique within the org, used as the stable key. */
  slug: string;
  /** Human-readable team name. */
  name: string;
  /**
   * Logins of the team's members. Currently capped at the first 100 members
   * per team (and the first 100 teams per org) — see `listTeamsForOrg`.
   */
  memberLogins: string[];
}
