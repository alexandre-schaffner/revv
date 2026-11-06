/** Strip protocol, whitespace and trailing slashes so a pasted URL becomes a host. */
export function normalizeGithubHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .trim();
}

/** "GitHub" for github.com, the host itself for an Enterprise instance. */
export function githubHostLabel(host: string): string {
  return host === "github.com" ? "GitHub" : host;
}
