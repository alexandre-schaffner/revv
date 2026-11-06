export function normalizeGithubHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .trim();
}

export function githubHostLabel(host: string): string {
  return host === "github.com" ? "GitHub" : host;
}
