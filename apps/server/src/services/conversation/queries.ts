// GraphQL documents for the Conversation tab. Two shapes of each: the modern
// one, and a legacy one for GitHub Enterprise releases that predate a field
// (see MODERN_TOKENS); `github.ts` picks between them.

/**
 * Fields a GitHub Enterprise release may predate. GraphQL rejects the whole
 * query on one unknown field or enum value, so on a schema complaint naming
 * any of these the query is asked again without them (`withSchemaFallback`).
 * `stack` is too common a word to match bare; GitHub's complaint quotes it.
 */
export const MODERN_TOKENS = [
  "isRequired",
  "closingIssuesReferences",
  "latestOpinionatedReviews",
  "latestReviews",
  "CONVERT_TO_DRAFT_EVENT",
  "convertToDraft",
  "asCodeOwner",
  "PullRequestStack",
  "Field 'stack'",
  "STACK_EVENT",
  "StackEvent",
] as const;

// The timeline is read newest first, a page at a time backwards, so a PR past
// the cap loses its oldest activity, never its latest.
const TIMELINE_PAGE = 100;
export const TIMELINE_MAX_PAGES = 5;

const ACTOR = `login avatarUrl __typename ... on User { name databaseId }`;

function timelineTypes(modern: boolean): string {
  return [
    "ISSUE_COMMENT",
    "PULL_REQUEST_REVIEW",
    "PULL_REQUEST_COMMIT",
    "REVIEW_REQUESTED_EVENT",
    "REVIEW_REQUEST_REMOVED_EVENT",
    "REVIEW_DISMISSED_EVENT",
    "LABELED_EVENT",
    "UNLABELED_EVENT",
    "ASSIGNED_EVENT",
    "UNASSIGNED_EVENT",
    "HEAD_REF_FORCE_PUSHED_EVENT",
    "READY_FOR_REVIEW_EVENT",
    ...(modern
      ? ["CONVERT_TO_DRAFT_EVENT", "ADDED_TO_STACK_EVENT", "REMOVED_FROM_STACK_EVENT"]
      : []),
    "MERGED_EVENT",
    "CLOSED_EVENT",
    "REOPENED_EVENT",
    "RENAMED_TITLE_EVENT",
    "CROSS_REFERENCED_EVENT",
  ].join(", ");
}

const TIMELINE_NODE = `
  __typename
  ... on IssueComment {
    id databaseId body createdAt lastEditedAt url viewerCanUpdate viewerCanDelete
    author { ${ACTOR} }
  }
  ... on PullRequestReview {
    id body state submittedAt createdAt url
    author { ${ACTOR} }
    comments { totalCount }
  }
  ... on PullRequestCommit {
    id url
    commit {
      oid messageHeadline messageBody committedDate
      author { name avatarUrl user { login name databaseId } }
      signature { isValid }
      statusCheckRollup { state }
    }
  }
  ... on ReviewRequestedEvent {
    id createdAt actor { ${ACTOR} }
    requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { combinedSlug } }
  }
  ... on ReviewRequestRemovedEvent {
    id createdAt actor { ${ACTOR} }
    requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { combinedSlug } }
  }
  ... on ReviewDismissedEvent {
    id createdAt actor { ${ACTOR} } dismissalMessage
    review { author { login } }
  }
  ... on LabeledEvent { id createdAt actor { ${ACTOR} } label { name color description } }
  ... on UnlabeledEvent { id createdAt actor { ${ACTOR} } label { name color description } }
  ... on AssignedEvent {
    id createdAt actor { ${ACTOR} }
    assignee { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Organization { login } }
  }
  ... on UnassignedEvent {
    id createdAt actor { ${ACTOR} }
    assignee { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Organization { login } }
  }
  ... on HeadRefForcePushedEvent {
    id createdAt actor { ${ACTOR} }
    beforeCommit { oid } afterCommit { oid }
  }
  ... on ReadyForReviewEvent { id createdAt actor { ${ACTOR} } }
  ... on MergedEvent { id createdAt actor { ${ACTOR} } commit { oid } mergeRefName }
  ... on ClosedEvent { id createdAt actor { ${ACTOR} } }
  ... on ReopenedEvent { id createdAt actor { ${ACTOR} } }
  ... on RenamedTitleEvent { id createdAt actor { ${ACTOR} } previousTitle currentTitle }
  ... on CrossReferencedEvent {
    id createdAt actor { ${ACTOR} }
    source {
      __typename
      ... on Issue { number title url state repository { nameWithOwner } }
      ... on PullRequest { number title url state repository { nameWithOwner } }
    }
  }
`;

function modernTimelineNodes(modern: boolean): string {
  return modern
    ? `... on ConvertToDraftEvent { id createdAt actor { ${ACTOR} } }
       ... on AddedToStackEvent { id createdAt actor { ${ACTOR} } stackNumber }
       ... on RemovedFromStackEvent { id createdAt actor { ${ACTOR} } stackNumber }`
    : "";
}

function checkContextsBlock(modern: boolean): string {
  const required = modern ? "isRequired(pullRequestNumber: $number)" : "";
  return `
    contexts(first: 100, after: $checkCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on CheckRun {
          databaseId name status conclusion startedAt completedAt detailsUrl title ${required}
          checkSuite { app { name slug } workflowRun { databaseId workflow { name } } }
        }
        ... on StatusContext {
          context state description targetUrl createdAt ${required}
        }
      }
    }
  `;
}

function rollupBlock(modern: boolean): string {
  return `
    commits(last: 1) {
      nodes {
        commit {
          oid
          statusCheckRollup {
            state
            ${checkContextsBlock(modern)}
          }
        }
      }
    }
  `;
}

export function conversationQuery(modern: boolean): string {
  return `
    query PrConversation($owner: String!, $repo: String!, $number: Int!, $checkCursor: String) {
      viewer { login }
      repository(owner: $owner, name: $repo) {
        viewerPermission
        pullRequest(number: $number) {
          number url body createdAt state isDraft reviewDecision viewerCanUpdate
          author { ${ACTOR} }
          milestone { title url dueOn state }
          ${modern ? "closingIssuesReferences(first: 10) { nodes { number title url state } }" : ""}
          ${
            modern
              ? `stack {
                   number baseRefName
                   entries(first: 50) {
                     nodes {
                       position
                       pullRequest { number title url state isDraft headRefName mergeStateStatus }
                     }
                   }
                 }`
              : ""
          }
          labels(first: 50) { nodes { name color description } }
          assignees(first: 20) { nodes { login name avatarUrl databaseId } }
          participants(first: 30) { nodes { login name avatarUrl databaseId } }
          reviewRequests(first: 50) {
            nodes {
              ${modern ? "asCodeOwner" : ""}
              requestedReviewer {
                __typename
                ... on User { login name avatarUrl databaseId }
                ... on Bot { login avatarUrl }
                ... on Mannequin { login avatarUrl }
                ... on Team { slug name combinedSlug }
              }
            }
          }
          ${
            modern
              ? `latestOpinionatedReviews(first: 50, writersOnly: true) {
                   nodes { state submittedAt author { ${ACTOR} } }
                 }
                 latestReviews(first: 50) {
                   nodes { state submittedAt author { ${ACTOR} } }
                 }`
              : `reviews(last: 100) { nodes { state submittedAt author { ${ACTOR} } } }`
          }
          timelineItems(last: ${TIMELINE_PAGE}, itemTypes: [${timelineTypes(modern)}]) {
            pageInfo { hasPreviousPage startCursor }
            nodes { ${TIMELINE_NODE} ${modernTimelineNodes(modern)} }
          }
          ${rollupBlock(modern)}
        }
      }
    }
  `;
}

export function timelinePageQuery(modern: boolean): string {
  return `
    query PrConversationTimeline($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          timelineItems(last: ${TIMELINE_PAGE}, before: $cursor, itemTypes: [${timelineTypes(modern)}]) {
            pageInfo { hasPreviousPage startCursor }
            nodes { ${TIMELINE_NODE} ${modernTimelineNodes(modern)} }
          }
        }
      }
    }
  `;
}

export function checksQuery(modern: boolean): string {
  return `
    query PrChecks($owner: String!, $repo: String!, $number: Int!, $checkCursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { ${rollupBlock(modern)} }
      }
    }
  `;
}

/** Follow-up CI pages stay on the original head even if the PR receives a commit. */
export function checkContextsPageQuery(modern: boolean): string {
  // Legacy fields do not reference $number; GraphQL rejects unused variables.
  return `
    query PrCheckContexts($owner: String!, $repo: String!, $sha: GitObjectID!, $checkCursor: String${modern ? ", $number: Int!" : ""}) {
      repository(owner: $owner, name: $repo) {
        object(oid: $sha) {
          ... on Commit { statusCheckRollup { state ${checkContextsBlock(modern)} } }
        }
      }
    }
  `;
}

/** The base branch's CODEOWNERS, at each place GitHub looks for one. */
export const CODEOWNERS_QUERY = `
  query PrCodeowners($owner: String!, $repo: String!, $a: String!, $b: String!, $c: String!) {
    repository(owner: $owner, name: $repo) {
      a: object(expression: $a) { ... on Blob { text } }
      b: object(expression: $b) { ... on Blob { text } }
      c: object(expression: $c) { ... on Blob { text } }
    }
  }
`;
