/**
 * Compare two provider logins. GitHub logins are case-insensitive, so `"Alex"`
 * and `"alex"` are the same account; either being absent is never a match.
 */
export function loginsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The signed-in local user, and the host of the account a request that names
 * no repository acts as (the active host's, else another of theirs; null with
 * none usable). Each account's login, avatar and re-auth state come from
 * `/api/auth/accounts`.
 */
export interface UserIdentity {
  id: string;
  name: string;
  email: string;
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
