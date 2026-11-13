import { describe, expect, it } from "bun:test";
import {
  type ConversationActor,
  type PrConversation,
  parseCodeowners,
  type ReviewerEntry,
  type TimelineItem,
} from "@revv/shared";
import { ownedFileTitle, reasonText, reviewOwnership } from "./codeowners-review";

const actor = (login: string): ConversationActor => ({
  login,
  name: null,
  avatarContent: null,
  kind: "user",
});

const user = (
  login: string,
  rest: Partial<Extract<ReviewerEntry, { kind: "user" }>> = {},
): ReviewerEntry => ({
  kind: "user",
  actor: actor(login),
  requested: false,
  asCodeOwner: false,
  verdict: null,
  verdictAt: null,
  onBehalfOf: [],
  ...rest,
});

const team = (combinedSlug: string, asCodeOwner: boolean): ReviewerEntry => ({
  kind: "team",
  combinedSlug,
  slug: combinedSlug.split("/")[1] ?? combinedSlug,
  name: combinedSlug,
  requested: true,
  asCodeOwner,
});

const requested = (by: string, reviewer: string): TimelineItem => ({
  kind: "review_requested",
  id: `rr-${by}-${reviewer}`,
  createdAt: "2026-10-12T10:00:00Z",
  actor: actor(by),
  reviewer,
  reviewerIsTeam: reviewer.includes("/"),
});

const CODEOWNERS = parseCodeowners(
  ["*            @o/everyone", "/apps/web/    @o/web", "/apps/server/ @o/api @me", "*.md"].join(
    "\n",
  ),
);

const PATHS = ["apps/web/a.ts", "apps/web/b.ts", "apps/server/c.ts", "README.md", "package.json"];

function conversation(overrides: Partial<PrConversation> = {}): PrConversation {
  return {
    prId: "pr-1",
    number: 1,
    url: "",
    body: "",
    author: actor("alice"),
    createdAt: "2026-10-12T10:00:00Z",
    state: "open",
    isDraft: false,
    reviewDecision: null,
    viewerLogin: "me",
    viewerTeams: ["o/web"],
    viewerCanUpdate: true,
    viewerCanPush: true,
    labels: [],
    assignees: [],
    reviewers: [],
    milestone: null,
    linkedIssues: [],
    codeowners: { path: ".github/CODEOWNERS", ref: "main", rules: CODEOWNERS },
    participants: [],
    timeline: [],
    timelineTruncated: false,
    ci: null,
    ciAccess: "granted",
    avatars: {},
    fetchedAt: "2026-10-12T10:00:00Z",
    ...overrides,
  };
}

describe("reviewOwnership", () => {
  it("explains a team request from CODEOWNERS and counts the viewer's files", () => {
    const own = reviewOwnership(conversation({ reviewers: [team("o/web", true)] }), PATHS);
    expect(own.reason).toEqual({ kind: "codeowners", via: ["@o/web"] });
    expect(reasonText(own.reason ?? { kind: "owner" })).toBe("Requested as @o/web via CODEOWNERS");
    // Mine through the team (web) and personally (server); `*.md` has no owner.
    expect([...own.mine.keys()].sort()).toEqual([
      "apps/server/c.ts",
      "apps/web/a.ts",
      "apps/web/b.ts",
    ]);
    expect(own.totalFiles).toBe(5);
  });

  it("lets the last matching rule win, and an ownerless rule unown", () => {
    const own = reviewOwnership(conversation(), PATHS);
    const handles = own.groups.map((g) => [g.handle, g.files.length]);
    expect(handles).toEqual([
      ["o/web", 2],
      ["me", 1],
      ["o/api", 1],
      ["o/everyone", 1],
    ]);
    expect(own.groups.find((g) => g.handle === "o/everyone")?.files).toEqual(["package.json"]);
  });

  it("points a file at the rule and line that owns it", () => {
    const own = reviewOwnership(conversation(), PATHS);
    const file = own.mine.get("apps/server/c.ts");
    expect(file?.rule.line).toBe(3);
    expect(file?.via).toEqual(["@me"]);
    expect(file && ownedFileTitle(file, ".github/CODEOWNERS")).toBe(
      "Owned by @me\n.github/CODEOWNERS:3  /apps/server/ @o/api @me",
    );
  });

  it("names the member who approved for a team, after GitHub drops the team request", () => {
    const own = reviewOwnership(
      conversation({
        reviewers: [
          user("bob", { verdict: "approved", onBehalfOf: ["O/Web"] }),
          user("carol", { verdict: "changes_requested", onBehalfOf: ["o/api"] }),
        ],
      }),
      PATHS,
    );
    const web = own.groups.find((g) => g.handle === "o/web");
    expect(web?.status).toBe("approved");
    expect(web?.approvedBy).toEqual(["bob"]);
    expect(own.groups.find((g) => g.handle === "o/api")?.status).toBe("changes_requested");
    expect(own.groups.find((g) => g.handle === "o/everyone")?.status).toBe("pending");
    // No request is left open, but the viewer still owns files.
    expect(own.reason).toEqual({ kind: "owner" });
  });

  it("says who asked when no CODEOWNERS rule did", () => {
    const own = reviewOwnership(
      conversation({
        codeowners: null,
        reviewers: [user("me", { requested: true })],
        timeline: [requested("alice", "me")],
      }),
      PATHS,
    );
    expect(own.mine.size).toBe(0);
    expect(own.groups).toEqual([]);
    expect(reasonText(own.reason ?? { kind: "owner" })).toBe("Requested directly by the author");

    const byBob = reviewOwnership(
      conversation({
        reviewers: [team("o/web", false)],
        timeline: [requested("alice", "o/web"), requested("bob", "o/web")],
      }),
      PATHS,
    );
    expect(reasonText(byBob.reason ?? { kind: "owner" })).toBe("Requested as @o/web by @bob");
  });

  it("has no reason for the author or a bystander", () => {
    expect(reviewOwnership(conversation({ viewerLogin: "alice" }), PATHS).reason).toBeNull();
    expect(
      reviewOwnership(conversation({ viewerLogin: "zed", viewerTeams: [] }), PATHS).reason,
    ).toBeNull();
  });
});
