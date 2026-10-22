/**
 * Whether the lightweight PR list needs a separate GraphQL diff-stat read.
 * Decided by the head-SHA watermark, not counts: 0/0/0 is a valid fetched result.
 */
export function needsDiffStats(
  existing: { readonly headSha: string | null } | undefined,
  statsHeadSha: string | null | undefined,
  incomingHeadSha: string | null,
): boolean {
  return existing === undefined || statsHeadSha !== incomingHeadSha;
}
