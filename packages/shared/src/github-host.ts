/** Public GitHub. Every other host is a GitHub Enterprise instance. */
export const DEFAULT_GITHUB_HOST = "github.com";

/** A host as typed (any case, with or without scheme or trailing slash), as stored. */
export function normalizeGithubHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

/** Whether two hosts, however typed, name the same server. */
export function sameGithubHost(a: string, b: string): boolean {
  return normalizeGithubHost(a) === normalizeGithubHost(b);
}

export function isPublicGitHub(host: string): boolean {
  return sameGithubHost(host, DEFAULT_GITHUB_HOST);
}

export function githubHostLabel(host: string): string {
  return isPublicGitHub(host) ? "GitHub" : host;
}
