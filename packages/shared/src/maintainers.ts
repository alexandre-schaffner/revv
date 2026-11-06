// Maintainers skip the stable-channel update cooldown, seeing a release the
// moment CI publishes it.
export const MAINTAINER_LOGINS: readonly string[] = ["alexandre-schaffner"];

export function isMaintainerLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  return MAINTAINER_LOGINS.includes(login);
}
