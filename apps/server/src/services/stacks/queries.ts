// ── GitHub: one PR's stack ──────────────────────────────────────────────────
//
// The stack detail the review page and the stack flows read: every layer with
// enough of its state to say where it stands (merge readiness, reviews, CI,
// auto-merge), plus the repository's merge settings. Hosts that predate
// stacks reject the `stack` field; see `STACK_SCHEMA_TOKENS`.

/** Fragments of GitHub's complaint when the host has no stacks. */
export const STACK_SCHEMA_TOKENS = [
  "PullRequestStack",
  "Field 'stack'",
  "Field 'stackEntry'",
] as const;

/** GitHub caps a stack well below this; one page always holds it. */
const MAX_LAYERS = 50;

export const PR_STACK_QUERY = `
  query PrStack($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      viewerPermission
      autoMergeAllowed
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
      pullRequest(number: $number) {
        stack {
          number
          baseRefName
          entries(first: ${MAX_LAYERS}) {
            nodes {
              position
              pullRequest {
                id
                number
                title
                url
                state
                isDraft
                headRefName
                headRefOid
                baseRefName
                mergeStateStatus
                reviewDecision
                additions
                deletions
                changedFiles
                mergedAt
                isInMergeQueue
                author { login }
                autoMergeRequest { enabledAt }
                viewerLatestReview { state }
                commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
              }
            }
          }
        }
      }
    }
  }
`;

export interface RawStackPullRequest {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly headRefOid: string | null;
  readonly baseRefName: string;
  readonly mergeStateStatus: string | null;
  readonly reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly isInMergeQueue: boolean;
  readonly author: { readonly login: string } | null;
  readonly autoMergeRequest: { readonly enabledAt: string | null } | null;
  readonly viewerLatestReview: { readonly state: string } | null;
  readonly commits: {
    readonly nodes: ReadonlyArray<{
      readonly commit: { readonly statusCheckRollup: { readonly state: string } | null };
    } | null> | null;
  } | null;
}

export interface RawPrStackAnswer {
  readonly repository: {
    readonly viewerPermission?: string | null;
    readonly autoMergeAllowed: boolean;
    readonly mergeCommitAllowed: boolean;
    readonly squashMergeAllowed: boolean;
    readonly rebaseMergeAllowed: boolean;
    readonly pullRequest: {
      readonly stack: {
        readonly number: number;
        readonly baseRefName: string;
        readonly entries: {
          readonly nodes: ReadonlyArray<{
            readonly position: number;
            readonly pullRequest: RawStackPullRequest | null;
          } | null> | null;
        };
      } | null;
    } | null;
  } | null;
}

// ── How far each layer is behind its base ───────────────────────────────────
//
// The stack query can't say whether a layer still sits on its base's tip:
// `mergeStateStatus` reports BEHIND only under strict branch protection, and
// `viewerCanUpdateBranch` is false on stacked PRs. `Ref.compare` answers it,
// one alias per open layer in a single query. A ref GitHub can't resolve (a
// deleted branch) comes back null rather than failing the query.

/** One layer to compare: its base branch against its head branch. */
export interface LayerComparison {
  readonly number: number;
  readonly baseRef: string;
  readonly headRef: string;
}

export function layerCompareQuery(layers: readonly LayerComparison[]): {
  query: string;
  variables: Record<string, string>;
} {
  const variables: Record<string, string> = {};
  const params: string[] = ["$owner: String!", "$repo: String!"];
  const fields = layers.map((layer, i) => {
    variables[`base${i}`] = `refs/heads/${layer.baseRef}`;
    variables[`head${i}`] = layer.headRef;
    params.push(`$base${i}: String!`, `$head${i}: String!`);
    return `l${layer.number}: ref(qualifiedName: $base${i}) { compare(headRef: $head${i}) { behindBy } }`;
  });
  return {
    query: `query LayerCompare(${params.join(", ")}) {
      repository(owner: $owner, name: $repo) {
        ${fields.join("\n        ")}
      }
    }`,
    variables,
  };
}

export interface RawLayerCompareAnswer {
  readonly repository: Readonly<
    Record<string, { readonly compare: { readonly behindBy: number } | null } | null>
  > | null;
}
