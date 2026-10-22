import { describe, expect, test } from "bun:test";
import {
  checkBucket,
  collectAvatarUrls,
  mapConversation,
  type RawConversation,
  type RawTimelineNode,
} from "./map";

const user = (login: string, extra: Record<string, unknown> = {}) => ({
  __typename: "User",
  login,
  avatarUrl: `https://avatars.example/${login}`,
  name: `${login} name`,
  databaseId: 1,
  ...extra,
});

function rawConversation(overrides: Record<string, unknown> = {}): RawConversation {
  return {
    viewer: { login: "me" },
    repository: {
      viewerPermission: "WRITE",
      pullRequest: {
        number: 42,
        url: "https://github.com/o/r/pull/42",
        body: "Fixes things",
        createdAt: "2026-10-01T10:00:00Z",
        state: "OPEN",
        isDraft: false,
        reviewDecision: "CHANGES_REQUESTED",
        viewerCanUpdate: true,
        author: user("alice"),
        milestone: null,
        closingIssuesReferences: {
          nodes: [{ number: 7, title: "Bug", url: "https://x/7", state: "OPEN" }],
        },
        labels: { nodes: [{ name: "api", color: "0e8a16", description: "" }] },
        assignees: { nodes: [user("bob")] },
        participants: { nodes: [user("alice"), user("bob")] },
        reviewRequests: {
          nodes: [
            { requestedReviewer: user("carol") },
            {
              requestedReviewer: {
                __typename: "Team",
                slug: "core",
                name: "Core",
                combinedSlug: "o/core",
              },
            },
          ],
        },
        latestOpinionatedReviews: {
          nodes: [
            {
              state: "CHANGES_REQUESTED",
              submittedAt: "2026-10-02T00:00:00Z",
              author: user("dave"),
            },
          ],
        },
        latestReviews: {
          nodes: [
            { state: "COMMENTED", submittedAt: "2026-10-03T00:00:00Z", author: user("dave") },
            { state: "COMMENTED", submittedAt: "2026-10-03T00:00:00Z", author: user("erin") },
          ],
        },
        timelineItems: {
          pageInfo: { hasPreviousPage: false, startCursor: null },
          nodes: [
            {
              __typename: "PullRequestCommit",
              id: "c1",
              url: "https://x/c1",
              commit: {
                oid: "abc123",
                messageHeadline: "feat: thing",
                messageBody: "",
                committedDate: "2026-10-01T11:00:00Z",
                author: { name: "Alice", user: { login: "alice", name: "Alice" } },
                signature: { isValid: true },
                statusCheckRollup: { state: "FAILURE" },
              },
            },
            {
              __typename: "IssueComment",
              id: "ic1",
              databaseId: 99,
              body: "LGTM?",
              createdAt: "2026-10-01T12:00:00Z",
              lastEditedAt: null,
              url: "https://x/ic1",
              viewerCanUpdate: false,
              viewerCanDelete: false,
              author: { __typename: "Bot", login: "ci-bot", avatarUrl: "https://a/bot" },
            },
            {
              __typename: "PullRequestReview",
              id: "r0",
              body: "",
              state: "PENDING",
              submittedAt: null,
              createdAt: "2026-10-01T12:30:00Z",
              url: "https://x/r0",
              author: user("me"),
              comments: { totalCount: 2 },
            },
            {
              __typename: "HeadRefForcePushedEvent",
              id: "fp1",
              createdAt: "2026-10-01T13:00:00Z",
              actor: user("alice"),
              beforeCommit: { oid: "aaa" },
              afterCommit: { oid: "bbb" },
            },
            {
              __typename: "LabeledEvent",
              id: "l1",
              createdAt: "2026-10-01T14:00:00Z",
              actor: null,
              label: { name: "api", color: "0e8a16", description: null },
            },
            { __typename: "SomethingNew", id: "x1", createdAt: "2026-10-01T15:00:00Z" },
          ],
        },
        commits: {
          nodes: [
            {
              commit: {
                oid: "abc123",
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        databaseId: 10,
                        name: "test",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                        startedAt: null,
                        completedAt: null,
                        detailsUrl: "https://x/10",
                        title: null,
                        isRequired: true,
                        checkSuite: {
                          app: { name: "GitHub Actions", slug: "github-actions" },
                          workflowRun: { databaseId: 5, workflow: { name: "CI" } },
                        },
                      },
                      // A re-run of the same job lands later in the list and wins.
                      {
                        __typename: "CheckRun",
                        databaseId: 11,
                        name: "test",
                        status: "IN_PROGRESS",
                        conclusion: null,
                        startedAt: null,
                        completedAt: null,
                        detailsUrl: "https://x/11",
                        title: null,
                        isRequired: true,
                        checkSuite: {
                          app: { name: "GitHub Actions", slug: "github-actions" },
                          workflowRun: { databaseId: 6, workflow: { name: "CI" } },
                        },
                      },
                      {
                        __typename: "StatusContext",
                        context: "vercel",
                        state: "SUCCESS",
                        description: "Deployed",
                        targetUrl: "https://v",
                        createdAt: "2026-10-01T11:00:00Z",
                        isRequired: false,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
        ...overrides,
      },
    },
  } as unknown as RawConversation;
}

describe("mapConversation", () => {
  const conversation = mapConversation(rawConversation(), [], "pr-1", false, "now");

  test("maps the PR's metadata", () => {
    expect(conversation).not.toBeNull();
    expect(conversation?.body).toBe("Fixes things");
    expect(conversation?.reviewDecision).toBe("changes_requested");
    expect(conversation?.viewerCanPush).toBe(true);
    expect(conversation?.labels).toEqual([{ name: "api", color: "0e8a16", description: null }]);
    expect(conversation?.linkedIssues).toEqual([
      { number: 7, title: "Bug", url: "https://x/7", state: "open" },
    ]);
  });

  test("merges requested reviewers, teams, and reviewers who already answered", () => {
    const reviewers = conversation?.reviewers ?? [];
    expect(reviewers.map((r) => (r.kind === "team" ? r.combinedSlug : r.actor.login))).toEqual([
      "carol",
      "o/core",
      "dave",
      "erin",
    ]);
    const dave = reviewers.find((r) => r.kind === "user" && r.actor.login === "dave");
    // An opinionated verdict beats a later plain comment.
    expect(dave?.kind === "user" && dave.verdict).toBe("changes_requested");
    const carol = reviewers.find((r) => r.kind === "user" && r.actor.login === "carol");
    expect(carol?.kind === "user" && carol.verdict).toBeNull();
  });

  test("maps timeline items and drops pending reviews and unknown nodes", () => {
    const kinds = conversation?.timeline.map((t) => t.kind);
    expect(kinds).toEqual(["commit", "comment", "force_pushed", "labeled"]);
    const comment = conversation?.timeline[1];
    expect(comment?.kind === "comment" && comment.author.kind).toBe("bot");
    const labeled = conversation?.timeline[3];
    expect(labeled?.kind === "labeled" && labeled.actor.kind).toBe("ghost");
    const commit = conversation?.timeline[0];
    expect(commit?.kind === "commit" && commit.ci).toBe("failure");
    expect(commit?.kind === "commit" && commit.verified).toBe(true);
  });

  test("keeps only the latest run of each check", () => {
    const checks = conversation?.ci?.checks ?? [];
    expect(checks.map((c) => [c.key, c.bucket])).toEqual([
      ["run:11", "pending"],
      ["status:vercel", "pass"],
    ]);
    expect(checks[0]?.workflowName).toBe("CI");
    expect(checks[0]?.workflowRunId).toBe(6);
  });

  test("reports CI the token can't read as denied, not as no checks", () => {
    const denied = mapConversation(rawConversation(), [], "pr-1", false, "now", "denied");
    expect(denied?.ciAccess).toBe("denied");
    expect(denied?.ci).toBeNull();
    expect(conversation?.ciAccess).toBe("granted");
  });

  test("reads legacy hosts that only have the reviews connection", () => {
    const legacy = mapConversation(
      rawConversation({
        latestOpinionatedReviews: undefined,
        latestReviews: undefined,
        closingIssuesReferences: undefined,
        reviews: {
          nodes: [
            { state: "APPROVED", submittedAt: "1", author: user("dave") },
            { state: "COMMENTED", submittedAt: "2", author: user("dave") },
          ],
        },
      }),
      [],
      "pr-1",
      false,
      "now",
    );
    const dave = legacy?.reviewers.find((r) => r.kind === "user" && r.actor.login === "dave");
    expect(dave?.kind === "user" && dave.verdict).toBe("approved");
    expect(legacy?.linkedIssues).toEqual([]);
  });

  test("puts older timeline pages before the query's newest page", () => {
    const older: RawTimelineNode = {
      __typename: "ClosedEvent",
      id: "old1",
      createdAt: "2026-09-01T00:00:00Z",
      actor: user("zed"),
    };
    const paged = mapConversation(rawConversation(), [older], "pr-1", true, "now");
    expect(paged?.timeline.map((t) => t.id)).toEqual(["old1", "c1", "ic1", "fp1", "l1"]);
    expect(paged?.timelineTruncated).toBe(true);
  });

  test("answers null when the PR isn't visible", () => {
    const raw = {
      viewer: { login: "me" },
      repository: { viewerPermission: null, pullRequest: null },
    };
    expect(mapConversation(raw, [], "pr-1", false, "now")).toBeNull();
  });
});

describe("collectAvatarUrls", () => {
  test("collects each login once", () => {
    const urls = collectAvatarUrls(rawConversation());
    expect(urls.get("alice")).toBe("https://avatars.example/alice");
    expect(urls.get("ci-bot")).toBe("https://a/bot");
    expect(urls.has("o/core")).toBe(false);
  });

  test("reads older timeline pages and commit authors too", () => {
    const older: RawTimelineNode = {
      __typename: "PullRequestCommit",
      id: "c0",
      url: "https://x/c0",
      commit: {
        oid: "000",
        messageHeadline: "init",
        messageBody: "",
        committedDate: "2026-09-01T00:00:00Z",
        author: { name: "Zed", avatarUrl: "https://a/zed", user: { login: "zed", name: null } },
        signature: null,
        statusCheckRollup: null,
      },
    };
    expect(collectAvatarUrls(rawConversation(), [older]).get("zed")).toBe("https://a/zed");
  });
});

describe("checkBucket", () => {
  test.each([
    ["check_run", "COMPLETED", "SUCCESS", "pass"],
    ["check_run", "COMPLETED", "SKIPPED", "skip"],
    ["check_run", "COMPLETED", "TIMED_OUT", "fail"],
    ["check_run", "COMPLETED", "CANCELLED", "fail"],
    ["check_run", "QUEUED", null, "pending"],
    ["status", "ERROR", null, "fail"],
    ["status", "EXPECTED", null, "pending"],
  ] as const)("%s %s %s → %s", (source, status, conclusion, bucket) => {
    expect(checkBucket(source, status, conclusion)).toBe(bucket);
  });
});
