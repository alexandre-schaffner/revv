/** Extract unique GitHub @-mentions from text using the legacy sync/parser rules. */
export function extractGitHubMentions(body: string): string[] {
  const matches = body.match(/@([a-zA-Z0-9-]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}
