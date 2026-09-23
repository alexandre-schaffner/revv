/**
 * Whether the lightweight PR list needs a separate GraphQL diff-stat read.
 *
 * Counts are deliberately absent from this decision: 0/0/0 is a valid
 * fetched result. Only the persisted head-SHA watermark distinguishes known
 * stats from the list endpoint's placeholder zeros.
 */
export function needsDiffStats(
  existing: { readonly headSha: string | null } | undefined,
  statsHeadSha: string | null | undefined,
  incomingHeadSha: string | null,
): boolean {
  return existing === undefined || statsHeadSha !== incomingHeadSha;
}
