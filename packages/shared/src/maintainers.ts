// GitHub logins that grant maintainer privileges in the in-app updater (skip the
// 48h stable-channel cooldown so they see new releases the moment CI publishes
// them). Kept as a small literal list — there is no admin surface to mutate it.
export const MAINTAINER_LOGINS: readonly string[] = ["alexandre-schaffner"];

export function isMaintainerLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  return MAINTAINER_LOGINS.includes(login);
}
