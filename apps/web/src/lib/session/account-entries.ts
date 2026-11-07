import { githubHostLabel } from "@revv/shared";
import type { LocalAccount } from "$lib/stores/auth.svelte";

/** One GitHub account a local user holds: a row in every account switcher. */
export interface AccountEntry {
  readonly key: string;
  readonly userId: string;
  readonly host: string;
  readonly hostLabel: string;
  readonly githubLogin: string | null;
  /** The GitHub login, else the local user's name. */
  readonly login: string;
  readonly email: string;
  /** The cached avatar bytes as a data URL: GitHub Enterprise's signed avatar URLs expire. */
  readonly avatarContent: string | null;
}

export function accountEntryKey(userId: string, host: string): string {
  return `${userId}:${host}`;
}

export function accountEntries(localAccounts: readonly LocalAccount[]): AccountEntry[] {
  return localAccounts.flatMap((local) =>
    local.accounts.map((account) => ({
      key: accountEntryKey(local.id, account.host),
      userId: local.id,
      host: account.host,
      hostLabel: githubHostLabel(account.host),
      githubLogin: account.githubLogin,
      login: account.githubLogin ?? local.name,
      email: local.email,
      avatarContent: account.avatarContent,
    })),
  );
}
