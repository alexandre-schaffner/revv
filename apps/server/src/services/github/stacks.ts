import {
  type CiRollupState,
  type GitHubStackLayerFields,
  isMergeableState,
  isOpenLayer,
  type MergeMethod,
  type ReviewDecision,
  type ReviewVerdict,
  type StackEntryStatus,
} from "@revv/shared";
import { Effect } from "effect";
import type { GitHubError } from "../../domain/errors";
import { logError } from "../../logger";
import { splitFullName } from "./graphql-batch";
import {
  type LayerComparison,
  layerCompareQuery,
  PR_STACK_QUERY,
  PR_STATE_QUERY,
  type RawLayerCompareAnswer,
  type RawPrStackAnswer,
  type RawPrState,
  type RawStackPullRequest,
  STACK_SCHEMA_TOKENS,
} from "./stack-queries";
import { type GitHubClient, type GitHubHttp, withSchemaFallback } from "./transport";

export function stackStatus(pr: {
  readonly state: string;
  readonly isDraft: boolean;
  readonly mergeStateStatus: string | null;
}): StackEntryStatus {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  return isMergeableState(pr.mergeStateStatus) ? "ready" : "not_ready";
}

export interface GitHubStackLayer extends GitHubStackLayerFields {
  readonly nodeId: string;
}

export interface GitHubStack {
  readonly number: number;
  readonly baseRefName: string;
  readonly layers: readonly GitHubStackLayer[];
  readonly autoMergeAllowed: boolean;
  readonly allowedMethods: readonly MergeMethod[];
  readonly viewerCanPush: boolean;
  readonly fetchedAt: string;
}

const REVIEW_DECISIONS: Record<string, ReviewDecision> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

const VERDICTS: Record<string, ReviewVerdict> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

const ROLLUP_STATES: Record<string, CiRollupState> = {
  SUCCESS: "success",
  FAILURE: "failure",
  PENDING: "pending",
  ERROR: "error",
  EXPECTED: "expected",
};

function mapLayer(position: number, pr: RawStackPullRequest): GitHubStackLayer {
  const rollup = pr.commits?.nodes?.[0]?.commit.statusCheckRollup?.state ?? null;
  return {
    nodeId: pr.id,
    position,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRef: pr.headRefName,
    status: stackStatus(pr),
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision ? (REVIEW_DECISIONS[pr.reviewDecision] ?? null) : null,
    viewerReview: pr.viewerLatestReview ? (VERDICTS[pr.viewerLatestReview.state] ?? null) : null,
    checks: rollup ? (ROLLUP_STATES[rollup] ?? null) : null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    authorLogin: pr.author?.login ?? null,
    mergedAt: pr.mergedAt,
    autoMergeEnabled: pr.autoMergeRequest !== null,
    isInMergeQueue: pr.isInMergeQueue,
    behindBy: null,
  };
}

const PUSH_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

function allowedMethodsOf(repo: NonNullable<RawPrStackAnswer["repository"]>): MergeMethod[] {
  const methods: MergeMethod[] = [];
  if (repo.mergeCommitAllowed) methods.push("merge");
  if (repo.squashMergeAllowed) methods.push("squash");
  if (repo.rebaseMergeAllowed) methods.push("rebase");
  return methods;
}

export function mapGitHubStack(answer: RawPrStackAnswer, fetchedAt: string): GitHubStack | null {
  const repo = answer.repository;
  const stack = repo?.pullRequest?.stack;
  if (!repo || !stack) return null;
  const layers = (stack.entries.nodes ?? [])
    .flatMap((entry) => (entry?.pullRequest ? [mapLayer(entry.position, entry.pullRequest)] : []))
    .sort((a, b) => a.position - b.position);
  if (layers.length < 2) return null;
  return {
    number: stack.number,
    baseRefName: stack.baseRefName,
    layers,
    autoMergeAllowed: repo.autoMergeAllowed,
    allowedMethods: allowedMethodsOf(repo),
    viewerCanPush: PUSH_PERMISSIONS.has(repo.viewerPermission ?? ""),
    fetchedAt,
  };
}

export function layersToCompare(stack: GitHubStack): LayerComparison[] {
  return stack.layers
    .filter(isOpenLayer)
    .map((l) => ({ number: l.number, baseRef: l.baseRef, headRef: l.headRef }));
}

export function withBehind(stack: GitHubStack, answer: RawLayerCompareAnswer): GitHubStack {
  const repo = answer.repository;
  if (!repo) return stack;
  return {
    ...stack,
    layers: stack.layers.map((layer) => {
      const behindBy = repo[`l${layer.number}`]?.compare?.behindBy;
      return typeof behindBy === "number" ? { ...layer, behindBy } : layer;
    }),
  };
}

export const stacksApi = (http: GitHubHttp) => {
  const withLayerBehind = (
    client: GitHubClient,
    ref: { owner: string; repo: string },
    stack: GitHubStack,
  ): Effect.Effect<GitHubStack> => {
    const layers = layersToCompare(stack);
    if (layers.length === 0) return Effect.succeed(stack);
    const { query, variables } = layerCompareQuery(layers);
    return http.graphqlPartial<RawLayerCompareAnswer>(client, query, { ...ref, ...variables }).pipe(
      Effect.map(({ data }) => withBehind(stack, data)),
      Effect.catch((err) =>
        Effect.sync(() => {
          logError("stacks", `comparing stack #${stack.number}'s layers failed`, err);
          return stack;
        }),
      ),
    );
  };

  return {
    /**
     * The stack PR `prNumber` sits in, with how far each open layer is behind
     * its base; null when it isn't stacked or the host predates stacks.
     */
    ofPr: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
    ): Effect.Effect<GitHubStack | null, GitHubError> =>
      Effect.gen(function* () {
        const ref = yield* splitFullName(fullName);
        const { value, modern } = yield* withSchemaFallback(
          (modern) =>
            modern
              ? http.graphql<RawPrStackAnswer>(client, PR_STACK_QUERY, { ...ref, number: prNumber })
              : Effect.succeed<RawPrStackAnswer>({ repository: null }),
          STACK_SCHEMA_TOKENS,
        );
        const stack = modern ? mapGitHubStack(value, new Date().toISOString()) : null;
        return stack ? yield* withLayerBehind(client, ref, stack) : null;
      }),

    /** A PR's state (`OPEN`, `CLOSED`, `MERGED`), or null when GitHub can't see it. */
    prState: (
      client: GitHubClient,
      fullName: string,
      prNumber: number,
    ): Effect.Effect<string | null, GitHubError> =>
      Effect.gen(function* () {
        const ref = yield* splitFullName(fullName);
        const answer = yield* http.graphql<RawPrState>(client, PR_STATE_QUERY, {
          ...ref,
          number: prNumber,
        });
        return answer.repository?.pullRequest?.state ?? null;
      }),
  };
};
