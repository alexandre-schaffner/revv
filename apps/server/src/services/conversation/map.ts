// GraphQL response → `PrConversation`. Pure: no I/O, no service deps.

import type {
  CiAccess,
  CiCheck,
  CiCheckBucket,
  CiRollup,
  CiRollupState,
  ConversationActor,
  LinkedIssue,
  PrConversation,
  PrLabel,
  PrStack,
  PrStackEntry,
  ReviewDecision,
  ReviewerEntry,
  ReviewVerdict,
  StackEntryStatus,
  TimelineItem,
} from "@revv/shared";

// ── Raw response shapes (only what the mapper reads) ────────────────────────

export interface RawActor {
  readonly __typename?: string;
  readonly login: string;
  readonly avatarUrl?: string | null;
  readonly name?: string | null;
  readonly databaseId?: number | null;
}

export interface RawLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

interface RawReview {
  readonly state: string;
  readonly submittedAt: string | null;
  readonly author: RawActor | null;
}

export interface RawConnection<N> {
  readonly nodes?: ReadonlyArray<N | null> | null;
}

/** A timeline page, read backwards: `startCursor` leads to older items. */
export interface RawPage<N> extends RawConnection<N> {
  readonly pageInfo: { readonly hasPreviousPage: boolean; readonly startCursor: string | null };
}

// One shape per timeline fragment in `queries.ts`.

interface RawEventBase {
  readonly id: string;
  readonly createdAt: string;
  readonly actor: RawActor | null;
}

interface RawIssueComment {
  readonly __typename: "IssueComment";
  readonly id: string;
  readonly databaseId: number;
  readonly body: string;
  readonly createdAt: string;
  readonly lastEditedAt: string | null;
  readonly url: string;
  readonly viewerCanUpdate: boolean;
  readonly viewerCanDelete: boolean;
  readonly author: RawActor | null;
}

interface RawReviewNode {
  readonly __typename: "PullRequestReview";
  readonly id: string;
  readonly body: string;
  readonly state: string;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly url: string;
  readonly author: RawActor | null;
  readonly comments: { readonly totalCount: number } | null;
}

interface RawCommitNode {
  readonly __typename: "PullRequestCommit";
  readonly id: string;
  readonly url: string;
  readonly commit: {
    readonly oid: string;
    readonly messageHeadline: string;
    readonly messageBody: string;
    readonly committedDate: string;
    readonly author: {
      readonly name: string | null;
      readonly avatarUrl?: string | null;
      readonly user: { readonly login: string; readonly name: string | null } | null;
    } | null;
    readonly signature: { readonly isValid: boolean } | null;
    readonly statusCheckRollup: { readonly state: string } | null;
  } | null;
}

/** A user, bot, or mannequin names a login; a team its `org/slug`. */
interface RawNamed {
  readonly __typename: string;
  readonly login?: string;
  readonly combinedSlug?: string;
}

interface RawCrossReferenceSource {
  readonly __typename: string;
  readonly number?: number;
  readonly title?: string;
  readonly url?: string;
  readonly state?: string;
  readonly repository?: { readonly nameWithOwner: string };
}

type RawEventNode = RawEventBase &
  (
    | {
        readonly __typename: "ReviewRequestedEvent" | "ReviewRequestRemovedEvent";
        readonly requestedReviewer: RawNamed | null;
      }
    | {
        readonly __typename: "ReviewDismissedEvent";
        readonly dismissalMessage: string | null;
        readonly review: { readonly author: { readonly login: string } | null } | null;
      }
    | {
        readonly __typename: "LabeledEvent" | "UnlabeledEvent";
        readonly label: RawLabel | null;
      }
    | {
        readonly __typename: "AssignedEvent" | "UnassignedEvent";
        readonly assignee: RawNamed | null;
      }
    | {
        readonly __typename: "HeadRefForcePushedEvent";
        readonly beforeCommit: { readonly oid: string } | null;
        readonly afterCommit: { readonly oid: string } | null;
      }
    | {
        readonly __typename:
          | "ReadyForReviewEvent"
          | "ConvertToDraftEvent"
          | "ClosedEvent"
          | "ReopenedEvent";
      }
    | {
        readonly __typename: "AddedToStackEvent" | "RemovedFromStackEvent";
        readonly stackNumber: number;
      }
    | {
        readonly __typename: "MergedEvent";
        readonly commit: { readonly oid: string } | null;
        readonly mergeRefName: string;
      }
    | {
        readonly __typename: "RenamedTitleEvent";
        readonly previousTitle: string;
        readonly currentTitle: string;
      }
    | {
        readonly __typename: "CrossReferencedEvent";
        readonly source: RawCrossReferenceSource | null;
      }
  );

export type RawTimelineNode = RawIssueComment | RawReviewNode | RawCommitNode | RawEventNode;

interface RawCheckContext {
  readonly __typename: string;
  readonly databaseId?: number | null;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly detailsUrl?: string | null;
  readonly title?: string | null;
  readonly isRequired?: boolean | null;
  readonly checkSuite?: {
    readonly app: { readonly name: string; readonly slug: string } | null;
    readonly workflowRun: {
      readonly databaseId: number;
      readonly workflow: { readonly name: string } | null;
    } | null;
  } | null;
  readonly context?: string;
  readonly state?: string;
  readonly description?: string | null;
  readonly targetUrl?: string | null;
  readonly createdAt?: string | null;
}

export interface RawRollupCommits {
  readonly nodes?: ReadonlyArray<{
    readonly commit: {
      readonly oid: string;
      readonly statusCheckRollup: {
        readonly state: string;
        readonly contexts: RawConnection<RawCheckContext>;
      } | null;
    };
  } | null> | null;
}

export interface RawPullRequest {
  readonly number: number;
  readonly url: string;
  readonly body: string | null;
  readonly createdAt: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly reviewDecision: string | null;
  readonly viewerCanUpdate: boolean;
  readonly author: RawActor | null;
  readonly milestone: {
    readonly title: string;
    readonly url: string;
    readonly dueOn: string | null;
    readonly state: string;
  } | null;
  readonly closingIssuesReferences?: RawConnection<{
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly state: string;
  }>;
  readonly stack?: {
    readonly number: number;
    readonly baseRefName: string;
    readonly entries: RawConnection<{
      readonly position: number;
      readonly pullRequest: {
        readonly number: number;
        readonly title: string;
        readonly url: string;
        readonly state: string;
        readonly isDraft: boolean;
        readonly headRefName: string;
        readonly mergeStateStatus: string | null;
      } | null;
    }>;
  } | null;
  readonly labels: RawConnection<RawLabel> | null;
  readonly assignees: RawConnection<RawActor>;
  readonly participants: RawConnection<RawActor>;
  readonly reviewRequests: RawConnection<{
    /** Absent on hosts that predate it. */
    readonly asCodeOwner?: boolean;
    readonly requestedReviewer:
      | (RawActor & { readonly __typename: "User" | "Bot" | "Mannequin" })
      | {
          readonly __typename: "Team";
          readonly slug: string;
          readonly name: string;
          readonly combinedSlug: string;
        }
      | null;
  }> | null;
  readonly latestOpinionatedReviews?: RawConnection<RawReview> | null;
  readonly latestReviews?: RawConnection<RawReview> | null;
  readonly reviews?: RawConnection<RawReview> | null;
  readonly timelineItems: RawPage<RawTimelineNode> | null;
  readonly commits: RawRollupCommits;
}

export interface RawConversation {
  readonly viewer: { readonly login: string };
  readonly repository: {
    readonly viewerPermission: string | null;
    readonly pullRequest: RawPullRequest | null;
  } | null;
}

// ── Mapping ─────────────────────────────────────────────────────────────────

export function nodesOf<N>(connection: RawConnection<N> | null | undefined): N[] {
  return (connection?.nodes ?? []).filter((n): n is N => n !== null);
}

const GHOST: ConversationActor = {
  login: "ghost",
  name: null,
  avatarContent: null,
  kind: "ghost",
};

function toActor(raw: RawActor | null | undefined): ConversationActor {
  if (!raw) return GHOST;
  const kind =
    raw.__typename === "Bot" ? "bot" : raw.__typename === "Mannequin" ? "mannequin" : "user";
  return {
    login: raw.login,
    name: raw.name?.trim() || null,
    avatarContent: null,
    kind,
  };
}

export function toLabel(raw: RawLabel): PrLabel {
  return { name: raw.name, color: raw.color, description: raw.description || null };
}

function toVerdict(state: string): ReviewVerdict | null {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    default:
      // PENDING is the viewer's own unsubmitted review: the Your review
      // section owns that, and nobody else can see it.
      return null;
  }
}

function toDecision(raw: string | null): ReviewDecision | null {
  switch (raw) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return null;
  }
}

function toRollupState(raw: string | null | undefined): CiRollupState | null {
  switch (raw) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
      return "failure";
    case "PENDING":
      return "pending";
    case "ERROR":
      return "error";
    case "EXPECTED":
      return "expected";
    default:
      return null;
  }
}

/** Where a check run or status lands, from GitHub's status + conclusion. */
export function checkBucket(
  source: "check_run" | "status",
  status: string,
  conclusion: string | null,
): CiCheckBucket {
  if (source === "status") {
    switch (status) {
      case "SUCCESS":
        return "pass";
      case "FAILURE":
      case "ERROR":
        return "fail";
      default:
        return "pending";
    }
  }
  if (status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "pass";
    case "SKIPPED":
    case "NEUTRAL":
    case "STALE":
      return "skip";
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
    case "CANCELLED":
      return "fail";
    default:
      return "pending";
  }
}

function toCheck(raw: RawCheckContext): CiCheck | null {
  if (raw.__typename === "CheckRun" && raw.name !== undefined && raw.status !== undefined) {
    const conclusion = raw.conclusion ?? null;
    const isActions = raw.checkSuite?.app?.slug === "github-actions";
    return {
      key: `run:${raw.databaseId ?? raw.name}`,
      source: "check_run",
      name: raw.name,
      workflowName: isActions ? (raw.checkSuite?.workflowRun?.workflow?.name ?? null) : null,
      appName: raw.checkSuite?.app?.name ?? null,
      bucket: checkBucket("check_run", raw.status, conclusion),
      outcome: (conclusion ?? raw.status).toLowerCase(),
      description: raw.title?.trim() || null,
      url: raw.detailsUrl ?? null,
      startedAt: raw.startedAt ?? null,
      completedAt: raw.completedAt ?? null,
      required: raw.isRequired ?? null,
      checkRunId: raw.databaseId ?? null,
      workflowRunId: isActions ? (raw.checkSuite?.workflowRun?.databaseId ?? null) : null,
    };
  }
  if (raw.__typename === "StatusContext" && raw.context !== undefined && raw.state !== undefined) {
    return {
      key: `status:${raw.context}`,
      source: "status",
      name: raw.context,
      workflowName: null,
      appName: null,
      bucket: checkBucket("status", raw.state, null),
      outcome: raw.state.toLowerCase(),
      description: raw.description?.trim() || null,
      url: raw.targetUrl ?? null,
      startedAt: raw.createdAt ?? null,
      completedAt: null,
      required: raw.isRequired ?? null,
      checkRunId: null,
      workflowRunId: null,
    };
  }
  return null;
}

export function mapRollup(commits: RawRollupCommits | null | undefined): CiRollup | null {
  const head = nodesOf(commits ?? null)[0]?.commit;
  if (!head) return null;
  const rollup = head.statusCheckRollup;
  // GitHub reports a check suite once per re-run; only the latest run of a
  // given name is the one that counts, and the list is newest-last.
  const byKey = new Map<string, CiCheck>();
  for (const raw of nodesOf(rollup?.contexts)) {
    const check = toCheck(raw);
    if (!check) continue;
    const identity = `${check.source}:${check.workflowName ?? ""}/${check.name}`;
    byKey.set(identity, check);
  }
  return {
    headSha: head.oid,
    state: toRollupState(rollup?.state),
    checks: [...byKey.values()],
  };
}

/** One raw timeline node → zero or one item. Partial nodes drop. */
function toTimelineItem(node: RawTimelineNode): TimelineItem | null {
  switch (node.__typename) {
    case "IssueComment":
      return {
        kind: "comment",
        id: node.id,
        createdAt: node.createdAt,
        databaseId: node.databaseId,
        author: toActor(node.author),
        body: node.body,
        edited: node.lastEditedAt !== null,
        url: node.url,
        viewerCanUpdate: node.viewerCanUpdate,
        viewerCanDelete: node.viewerCanDelete,
      };
    case "PullRequestReview": {
      const verdict = toVerdict(node.state);
      if (!verdict) return null;
      return {
        kind: "review",
        id: node.id,
        createdAt: node.submittedAt ?? node.createdAt,
        author: toActor(node.author),
        verdict,
        body: node.body,
        url: node.url,
        inlineCommentCount: node.comments?.totalCount ?? 0,
      };
    }
    case "PullRequestCommit": {
      const { commit } = node;
      if (!commit) return null;
      const user = commit.author?.user;
      const author: ConversationActor = user
        ? { login: user.login, name: user.name || null, avatarContent: null, kind: "user" }
        : {
            login: commit.author?.name ?? "unknown",
            name: commit.author?.name ?? null,
            avatarContent: null,
            kind: "ghost",
          };
      return {
        kind: "commit",
        id: node.id,
        createdAt: commit.committedDate,
        sha: commit.oid,
        headline: commit.messageHeadline,
        messageBody: commit.messageBody,
        author,
        url: node.url,
        verified: commit.signature ? commit.signature.isValid : null,
        ci: toRollupState(commit.statusCheckRollup?.state),
      };
    }
    default:
      return toEventItem(node);
  }
}

function toEventItem(node: RawEventNode): TimelineItem | null {
  const base = { id: node.id, createdAt: node.createdAt, actor: toActor(node.actor) };
  switch (node.__typename) {
    case "ReviewRequestedEvent":
    case "ReviewRequestRemovedEvent": {
      const reviewer = node.requestedReviewer;
      const name = reviewer?.combinedSlug ?? reviewer?.login;
      if (!name) return null;
      return {
        ...base,
        kind:
          node.__typename === "ReviewRequestedEvent"
            ? "review_requested"
            : "review_request_removed",
        reviewer: name,
        reviewerIsTeam: reviewer?.__typename === "Team",
      };
    }
    case "ReviewDismissedEvent":
      return {
        ...base,
        kind: "review_dismissed",
        reviewer: node.review?.author?.login ?? null,
        message: node.dismissalMessage,
      };
    case "LabeledEvent":
    case "UnlabeledEvent":
      if (!node.label) return null;
      return {
        ...base,
        kind: node.__typename === "LabeledEvent" ? "labeled" : "unlabeled",
        label: toLabel(node.label),
      };
    case "AssignedEvent":
    case "UnassignedEvent":
      if (!node.assignee?.login) return null;
      return {
        ...base,
        kind: node.__typename === "AssignedEvent" ? "assigned" : "unassigned",
        assignee: node.assignee.login,
      };
    case "HeadRefForcePushedEvent":
      return {
        ...base,
        kind: "force_pushed",
        beforeSha: node.beforeCommit?.oid ?? null,
        afterSha: node.afterCommit?.oid ?? null,
      };
    case "ReadyForReviewEvent":
      return { ...base, kind: "ready_for_review" };
    case "ConvertToDraftEvent":
      return { ...base, kind: "converted_to_draft" };
    case "ClosedEvent":
      return { ...base, kind: "closed" };
    case "ReopenedEvent":
      return { ...base, kind: "reopened" };
    case "AddedToStackEvent":
    case "RemovedFromStackEvent":
      return {
        ...base,
        kind: node.__typename === "AddedToStackEvent" ? "added_to_stack" : "removed_from_stack",
        stackNumber: node.stackNumber,
      };
    case "MergedEvent":
      return {
        ...base,
        kind: "merged",
        commitSha: node.commit?.oid ?? null,
        baseRef: node.mergeRefName,
      };
    case "RenamedTitleEvent":
      return { ...base, kind: "renamed", from: node.previousTitle, to: node.currentTitle };
    case "CrossReferencedEvent": {
      const { source } = node;
      if (!source?.number || !source.url) return null;
      const state = source.state?.toLowerCase();
      return {
        ...base,
        kind: "cross_referenced",
        source: {
          type: source.__typename === "PullRequest" ? "pull_request" : "issue",
          number: source.number,
          title: source.title ?? "",
          url: source.url,
          repo: source.repository?.nameWithOwner ?? "",
          state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
        },
      };
    }
    default:
      // A type GitHub added after this mapper was written.
      return null;
  }
}

function mapReviewers(pr: RawPullRequest): ReviewerEntry[] {
  // Latest verdict per login. `latestOpinionatedReviews` wins over a later
  // plain comment (GitHub's own sidebar does the same: an approval followed
  // by a comment still reads as an approval).
  const verdicts = new Map<string, { verdict: ReviewVerdict; at: string | null; raw: RawActor }>();
  const record = (reviews: RawReview[], overwrite: boolean) => {
    for (const review of reviews) {
      const verdict = toVerdict(review.state);
      if (!verdict || !review.author) continue;
      const login = review.author.login;
      if (!overwrite && verdicts.has(login)) continue;
      verdicts.set(login, { verdict, at: review.submittedAt, raw: review.author });
    }
  };
  if (pr.latestOpinionatedReviews || pr.latestReviews) {
    record(nodesOf(pr.latestOpinionatedReviews), true);
    record(nodesOf(pr.latestReviews), false);
  } else {
    // Legacy hosts: walk every review oldest → newest; an opinionated
    // verdict sticks unless a later opinionated one replaces it.
    for (const review of nodesOf(pr.reviews)) {
      const verdict = toVerdict(review.state);
      if (!verdict || !review.author) continue;
      const prior = verdicts.get(review.author.login);
      const opinionated = verdict === "approved" || verdict === "changes_requested";
      const priorOpinionated =
        prior?.verdict === "approved" || prior?.verdict === "changes_requested";
      if (!prior || opinionated || !priorOpinionated) {
        verdicts.set(review.author.login, { verdict, at: review.submittedAt, raw: review.author });
      }
    }
  }

  const entries: ReviewerEntry[] = [];
  const seen = new Set<string>();
  for (const request of nodesOf(pr.reviewRequests)) {
    const reviewer = request.requestedReviewer;
    if (!reviewer) continue;
    if (reviewer.__typename === "Team") {
      entries.push({
        kind: "team",
        combinedSlug: reviewer.combinedSlug,
        slug: reviewer.slug,
        name: reviewer.name,
        requested: true,
        asCodeOwner: request.asCodeOwner === true,
      });
      continue;
    }
    const prior = verdicts.get(reviewer.login);
    seen.add(reviewer.login);
    entries.push({
      kind: "user",
      actor: toActor(reviewer),
      requested: true,
      asCodeOwner: request.asCodeOwner === true,
      verdict: prior?.verdict ?? null,
      verdictAt: prior?.at ?? null,
    });
  }
  const authorLogin = pr.author?.login;
  for (const [login, { verdict, at, raw }] of verdicts) {
    if (seen.has(login) || login === authorLogin) continue;
    entries.push({
      kind: "user",
      actor: toActor(raw),
      requested: false,
      asCodeOwner: false,
      verdict,
      verdictAt: at,
    });
  }
  return entries;
}

/** Merge states GitHub would let through once the PRs below have landed. */
const READY_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

function stackStatus(pr: {
  readonly state: string;
  readonly isDraft: boolean;
  readonly mergeStateStatus: string | null;
}): StackEntryStatus {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  return READY_MERGE_STATES.has(pr.mergeStateStatus ?? "") ? "ready" : "not_ready";
}

export function mapStack(raw: RawPullRequest["stack"]): PrStack | null {
  if (!raw) return null;
  const entries = nodesOf(raw.entries)
    .flatMap((entry): PrStackEntry[] =>
      entry.pullRequest
        ? [
            {
              position: entry.position,
              number: entry.pullRequest.number,
              title: entry.pullRequest.title,
              url: entry.pullRequest.url,
              headRef: entry.pullRequest.headRefName,
              status: stackStatus(entry.pullRequest),
            },
          ]
        : [],
    )
    .sort((a, b) => a.position - b.position);
  // A stack of one is just a PR.
  if (entries.length < 2) return null;
  return { number: raw.number, baseRefName: raw.baseRefName, entries };
}

const WRITE_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

/**
 * What GitHub's conversation query answers. CODEOWNERS comes from its own
 * query and avatars from the local cache; the service adds both.
 */
export type MappedConversation = Omit<PrConversation, "codeowners" | "avatars">;

/**
 * `olderTimeline` is the pages read before the query's own (newest) page,
 * oldest first.
 */
export function mapConversation(
  raw: RawConversation,
  olderTimeline: readonly RawTimelineNode[],
  prId: string,
  timelineTruncated: boolean,
  fetchedAt: string,
  ciAccess: CiAccess = "granted",
): MappedConversation | null {
  const pr = raw.repository?.pullRequest;
  if (!pr) return null;
  const timeline = [...olderTimeline, ...nodesOf(pr.timelineItems)]
    .map(toTimelineItem)
    .filter((item): item is TimelineItem => item !== null);
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open";
  const linkedIssues: LinkedIssue[] = nodesOf(pr.closingIssuesReferences).map((issue) => ({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state === "CLOSED" ? "closed" : "open",
  }));
  return {
    prId,
    number: pr.number,
    url: pr.url,
    body: pr.body ?? "",
    author: toActor(pr.author),
    createdAt: pr.createdAt,
    state,
    isDraft: pr.isDraft,
    reviewDecision: toDecision(pr.reviewDecision),
    viewerLogin: raw.viewer.login,
    viewerCanUpdate: pr.viewerCanUpdate,
    viewerCanPush: WRITE_PERMISSIONS.has(raw.repository?.viewerPermission ?? ""),
    labels: nodesOf(pr.labels).map(toLabel),
    assignees: nodesOf(pr.assignees).map(toActor),
    reviewers: mapReviewers(pr),
    milestone: pr.milestone
      ? {
          title: pr.milestone.title,
          url: pr.milestone.url,
          dueOn: pr.milestone.dueOn,
          state: pr.milestone.state === "CLOSED" ? "closed" : "open",
        }
      : null,
    linkedIssues,
    stack: mapStack(pr.stack),
    participants: nodesOf(pr.participants).map(toActor),
    timeline,
    timelineTruncated,
    ci: ciAccess === "denied" ? null : mapRollup(pr.commits),
    ciAccess,
    fetchedAt,
  };
}

/** The accounts a timeline node names, as GitHub sent them. */
function nodeActors(node: RawTimelineNode): Array<RawActor | null | undefined> {
  switch (node.__typename) {
    case "IssueComment":
    case "PullRequestReview":
      return [node.author];
    case "PullRequestCommit": {
      const author = node.commit?.author;
      return author?.user
        ? [{ login: author.user.login, avatarUrl: author.avatarUrl ?? null }]
        : [];
    }
    default:
      return [node.actor];
  }
}

/** Every login the conversation renders, with the avatar URL GitHub sent. */
export function collectAvatarUrls(
  raw: RawConversation,
  olderTimeline: readonly RawTimelineNode[] = [],
): Map<string, string> {
  const out = new Map<string, string>();
  const add = (actor: RawActor | null | undefined) => {
    if (actor?.login && actor.avatarUrl && !out.has(actor.login)) {
      out.set(actor.login, actor.avatarUrl);
    }
  };
  const pr = raw.repository?.pullRequest;
  if (!pr) return out;
  add(pr.author);
  for (const a of nodesOf(pr.assignees)) add(a);
  for (const a of nodesOf(pr.participants)) add(a);
  for (const r of nodesOf(pr.reviewRequests)) {
    const reviewer = r.requestedReviewer;
    if (reviewer && reviewer.__typename !== "Team") add(reviewer);
  }
  for (const r of [
    ...nodesOf(pr.latestOpinionatedReviews),
    ...nodesOf(pr.latestReviews),
    ...nodesOf(pr.reviews),
  ]) {
    add(r.author);
  }
  for (const node of [...olderTimeline, ...nodesOf(pr.timelineItems)]) {
    for (const actor of nodeActors(node)) add(actor);
  }
  return out;
}
