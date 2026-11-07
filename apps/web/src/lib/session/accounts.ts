// The signed-in user's GitHub accounts, one per host, and the changes the
// server pushes about one of them. Each change is to the account on its own
// host: another account's re-auth or identity never touches it.

import { sameGithubHost } from "@revv/shared";

export interface Account {
  readonly host: string;
  readonly githubLogin: string | null;
  /** The cached avatar bytes as a data URL: GitHub Enterprise's signed avatar URLs expire. */
  readonly avatarContent: string | null;
  /** Its token was refused and couldn't be refreshed: it must sign in again. */
  readonly reauthRequired: boolean;
}

export function accountOn(accounts: readonly Account[], host: string): Account | undefined {
  return accounts.find((a) => sameGithubHost(a.host, host));
}

/** The account on `host` needs re-auth or no longer does. One the list lacks is added when flagged. */
export function withReauth(
  accounts: readonly Account[],
  change: {
    readonly host: string;
    readonly reauthRequired: boolean;
    readonly githubLogin?: string | null;
  },
): readonly Account[] {
  const known = accountOn(accounts, change.host);
  if (!known) {
    return change.reauthRequired
      ? [
          ...accounts,
          {
            host: change.host,
            githubLogin: change.githubLogin ?? null,
            avatarContent: null,
            reauthRequired: true,
          },
        ]
      : accounts;
  }
  const next: Account = {
    ...known,
    reauthRequired: change.reauthRequired,
    ...(change.githubLogin !== undefined ? { githubLogin: change.githubLogin } : {}),
  };
  return accounts.map((a) => (a === known ? next : a));
}

/** GitHub reported the account on `host`'s login and avatar. Without cached bytes, the avatar shown stays. */
export function withIdentity(
  accounts: readonly Account[],
  change: {
    readonly host: string;
    readonly githubLogin: string | null;
    readonly avatarContent: string | null;
  },
): readonly Account[] {
  const known = accountOn(accounts, change.host);
  if (!known) return accounts;
  const next: Account = {
    ...known,
    githubLogin: change.githubLogin,
    avatarContent: change.avatarContent ?? known.avatarContent,
  };
  return accounts.map((a) => (a === known ? next : a));
}

/**
 * The accounts that must sign in again, split by the host the window shows:
 * that host's account blocks the window, the others wait in the account menu.
 * With no shown host, every host counts as shown.
 */
export function reauthAsked(
  accounts: readonly Account[],
  shownHost: string | null,
): { readonly blocking: Account | null; readonly waiting: readonly Account[] } {
  const flagged = accounts.filter((a) => a.reauthRequired);
  const shown = (a: Account) => shownHost === null || sameGithubHost(a.host, shownHost);
  return { blocking: flagged.find(shown) ?? null, waiting: flagged.filter((a) => !shown(a)) };
}
