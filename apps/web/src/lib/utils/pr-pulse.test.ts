import { describe, expect, it } from "bun:test";
import type {
  CiCheck,
  ConversationActor,
  MergeEligibility,
  PrConversation,
  ReviewerEntry,
  TimelineItem,
} from "@revv/shared";
import { commentGist, dayLabel } from "./conversation-timeline";
import { itemsSince, prPulse, summarizeFresh } from "./pr-pulse";

const actor = (login: string, kind: ConversationActor["kind"] = "user"): ConversationActor => ({
  login,
  name: null,
  avatarContent: null,
  kind,
});

const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, "0")}:00Z`;

const check = (name: string, bucket: CiCheck["bucket"]): CiCheck => ({
  key: `run:${name}`,
  source: "check_run",
  name,
  workflowName: null,
  appName: null,
  bucket,
  outcome: bucket,
  description: null,
  url: null,
  startedAt: null,
  completedAt: null,
  required: null,
  checkRunId: null,
  workflowRunId: null,
});

const reviewer = (
  login: string,
  verdict: "approved" | "changes_requested" | null,
): ReviewerEntry => ({
  kind: "user",
  actor: actor(login),
  requested: verdict === null,
  asCodeOwner: false,
  verdict,
  verdictAt: verdict ? at(1) : null,
});

const commit = (id: string, minute: number, login = "alice"): TimelineItem => ({
  kind: "commit",
  id,
  createdAt: at(minute),
  sha: id,
  headline: id,
  messageBody: "",
  author: actor(login),
  url: "",
  verified: null,
  ci: null,
});

function conversation(overrides: Partial<PrConversation> = {}): PrConversation {
  return {
    prId: "pr",
    number: 1,
    url: "",
    body: "",
    author: actor("alice"),
    createdAt: at(0),
    state: "open",
    isDraft: false,
    reviewDecision: null,
    viewerLogin: "viewer",
    viewerCanUpdate: true,
    viewerCanPush: true,
    labels: [],
    assignees: [],
    reviewers: [],
    milestone: null,
    linkedIssues: [],
    codeowners: null,
    participants: [],
    timeline: [],
    timelineTruncated: false,
    ci: { headSha: "abc", state: "success", checks: [check("lint", "pass")] },
    ciAccess: "granted",
    avatars: {},
    fetchedAt: at(30),
    ...overrides,
  };
}

const clean: MergeEligibility = {
  canMerge: true,
  canBypassProtections: false,
  mergeable: true,
  mergeStateStatus: "CLEAN",
  allowedMethods: ["squash"],
};

describe("prPulse", () => {
  it("calls a clean, approved, green PR ready to merge", () => {
    const pulse = prPulse(
      conversation({ reviewDecision: "approved", reviewers: [reviewer("bob", "approved")] }),
      clean,
      "main",
    );
    expect(pulse.state).toBe("open");
    expect(pulse.headline).toBe("Ready to merge");
    expect(pulse.reviews).toMatchObject({ tone: "good", title: "Approved", detail: "by bob" });
    expect(pulse.merge).toMatchObject({ tone: "good", title: "Ready" });
  });

  it("leads with failing checks and counts them", () => {
    const pulse = prPulse(
      conversation({
        ci: {
          headSha: "abc",
          state: "failure",
          checks: [check("lint", "fail"), check("test", "fail"), check("build", "pass")],
        },
      }),
      clean,
      "main",
    );
    expect(pulse.checks).toMatchObject({ tone: "bad", title: "2 failing", detail: "1 passed" });
    expect(pulse.headline).toBe("2 failing checks");
    expect(pulse.headlineTone).toBe("bad");
  });

  it("names everything still outstanding in one headline", () => {
    const pulse = prPulse(
      conversation({
        reviewDecision: "review_required",
        reviewers: [reviewer("bob", null)],
        ci: { headSha: "abc", state: "pending", checks: [check("lint", "pending")] },
      }),
      { ...clean, mergeStateStatus: "BLOCKED" },
      "main",
    );
    expect(pulse.headline).toBe("Waiting on checks and a review from bob");
    expect(pulse.merge).toMatchObject({ tone: "pending", title: "Blocked" });
  });

  it("reads conflicts as the first blocker", () => {
    const pulse = prPulse(conversation(), { ...clean, mergeStateStatus: "DIRTY" }, "main");
    expect(pulse.merge).toMatchObject({ tone: "bad", title: "Conflicts", detail: "with main" });
    expect(pulse.headline).toBe("Conflicts with main block the merge");
  });

  it("tells a merged PR by who merged it and when", () => {
    const pulse = prPulse(
      conversation({
        state: "merged",
        timeline: [
          {
            kind: "merged",
            id: "m",
            createdAt: at(20),
            actor: actor("carol"),
            commitSha: "a430195ffff",
            baseRef: "main",
          },
        ],
      }),
      null,
      "main",
    );
    expect(pulse.headline).toBe("carol merged this into main");
    expect(pulse.at).toBe(at(20));
    expect(pulse.merge.detail).toBe("into main as a430195");
  });

  it("says when the token can't see checks rather than claiming none", () => {
    const pulse = prPulse(conversation({ ciAccess: "denied", ci: null }), clean, "main");
    expect(pulse.checks.title).toBe("Hidden");
  });
});

describe("itemsSince / summarizeFresh", () => {
  const timeline = [commit("a", 1), commit("b", 5), commit("c", 6), commit("d", 7, "viewer")];

  it("keeps others' items after the last visit", () => {
    expect(itemsSince(timeline, at(2), "viewer").map((t) => t.id)).toEqual(["b", "c"]);
    expect(itemsSince(timeline, null, "viewer")).toEqual([]);
  });

  it("counts a run of the same person's commits", () => {
    const lines = summarizeFresh(itemsSince(timeline, at(0), "viewer"));
    expect(lines.map((l) => `${l.actor.login} ${l.text}`)).toEqual(["alice pushed 3 commits"]);
  });
});

describe("timeline helpers", () => {
  it("labels today and yesterday by name", () => {
    const now = new Date("2026-11-05T15:00:00");
    expect(dayLabel("2026-11-05T09:00:00", now)).toBe("Today");
    expect(dayLabel("2026-11-04T23:00:00", now)).toBe("Yesterday");
  });

  it("takes a bot report's heading as its gist", () => {
    expect(commentGist("<!-- marker -->\n## 🚓 Slop Cop\n\nInformative only")).toBe("Slop Cop");
    expect(commentGist("**Deploy** ready at [preview](https://x)")).toBe("Deploy ready at preview");
  });
});
