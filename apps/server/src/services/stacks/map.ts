import { isOpenLayer } from "@revv/shared";
import type { GitHubStack, GitHubStackLayer } from "../github/stacks";

export interface MirroredLayer {
  readonly number: number;
  readonly position: number;
  readonly title: string;
  readonly url: string;
  readonly status: string;
  readonly isDraft: boolean;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headSha: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly authorLogin: string;
  readonly closedAt: string | null;
  readonly fetchedAt: string;
}

function openMembership(
  layers: readonly {
    readonly number: number;
    readonly position: number;
    readonly status: string;
  }[],
): string {
  return layers
    .filter(isOpenLayer)
    .map((l) => `${l.number}@${l.position}`)
    .toSorted()
    .join(",");
}

export function membershipSupersededByPoll(
  read: GitHubStack,
  mirror: readonly MirroredLayer[],
): boolean {
  const pollWroteSince = mirror.some((l) => Date.parse(l.fetchedAt) > Date.parse(read.fetchedAt));
  return pollWroteSince && openMembership(read.layers) !== openMembership(mirror);
}

export function stackFromMirror(
  stackNumber: number,
  mirror: readonly MirroredLayer[],
  fetchedAt: string,
): GitHubStack | null {
  const rows = mirror.toSorted((a, b) => a.position - b.position);
  if (rows.length < 2) return null;
  const layers = rows.map(
    (row): GitHubStackLayer => ({
      nodeId: "",
      position: row.position,
      number: row.number,
      title: row.title,
      url: row.url,
      headRef: row.sourceBranch,
      status:
        row.status === "merged"
          ? "merged"
          : row.status === "closed"
            ? "closed"
            : row.isDraft
              ? "draft"
              : "not_ready",
      headSha: row.headSha,
      baseRef: row.targetBranch,
      mergeStateStatus: null,
      reviewDecision: null,
      viewerReview: null,
      checks: null,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changedFiles,
      authorLogin: row.authorLogin,
      mergedAt: row.status === "merged" ? row.closedAt : null,
      autoMergeEnabled: false,
      isInMergeQueue: false,
      behindBy: null,
    }),
  );
  return {
    number: stackNumber,
    baseRefName: rows[0]?.targetBranch ?? "",
    layers,
    autoMergeAllowed: false,
    allowedMethods: [],
    viewerCanPush: false,
    fetchedAt,
  };
}
