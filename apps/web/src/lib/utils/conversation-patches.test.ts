import { describe, expect, it } from "bun:test";
import type { ConversationActor, PrConversation, TimelineItem } from "@revv/shared";
import {
  addLabelsPatch,
  deleteCommentPatch,
  editBodyPatch,
  postCommentPatch,
  removeReviewersPatch,
  requestReviewersPatch,
} from "./conversation-patches";

const actor = (login: string): ConversationActor => ({
  login,
  name: null,
  avatarContent: null,
  kind: "user",
});

const comment = (databaseId: number, body: string): TimelineItem => ({
  kind: "comment",
  id: `ic${databaseId}`,
  createdAt: `2026-10-12T10:0${databaseId}:00Z`,
  databaseId,
  author: actor("alice"),
  body,
  edited: false,
  url: "",
  viewerCanUpdate: true,
  viewerCanDelete: true,
});

function conversation(overrides: Partial<PrConversation> = {}): PrConversation {
  return {
    prId: "pr-1",
    number: 1,
    url: "",
    body: "description",
    author: actor("alice"),
    createdAt: "2026-10-12T10:00:00Z",
    state: "open",
    isDraft: false,
    reviewDecision: null,
    viewerLogin: "me",
    viewerCanUpdate: true,
    viewerCanPush: true,
    labels: [],
    assignees: [],
    reviewers: [],
    milestone: null,
    linkedIssues: [],
    stack: null,
    codeowners: null,
    participants: [actor("me")],
    timeline: [comment(1, "one"), comment(2, "two"), comment(3, "three")],
    timelineTruncated: false,
    ci: null,
    ciAccess: "granted",
    avatars: {},
    fetchedAt: "2026-10-12T10:00:00Z",
    ...overrides,
  };
}

describe("conversation patches", () => {
  it("undoes only its own field, keeping what changed meanwhile", () => {
    const patch = editBodyPatch("new description");
    const shown = patch.apply(conversation());
    expect(shown.body).toBe("new description");
    // A CI poll replaced the conversation while the write was in flight.
    const polled = { ...shown, ci: { headSha: "abc", state: "pending" as const, checks: [] } };
    const undone = patch.undo(polled);
    expect(undone.body).toBe("description");
    expect(undone.ci?.headSha).toBe("abc");
  });

  it("drops a pending comment on undo", () => {
    const patch = postCommentPatch("hello", new Date("2026-10-12T11:00:00Z"));
    const shown = patch.apply(conversation());
    expect(shown.timeline.at(-1)?.kind === "comment" && shown.timeline.at(-1)).toMatchObject({
      body: "hello",
      author: { login: "me" },
    });
    expect(patch.undo(shown).timeline).toHaveLength(3);
  });

  it("puts a deleted comment back where it was", () => {
    const patch = deleteCommentPatch(2);
    const shown = patch.apply(conversation());
    expect(shown.timeline.map((t) => t.id)).toEqual(["ic1", "ic3"]);
    expect(patch.undo(shown).timeline.map((t) => t.id)).toEqual(["ic1", "ic2", "ic3"]);
  });

  it("restores a reviewer's earlier entry instead of dropping them", () => {
    const bob = {
      kind: "user" as const,
      actor: actor("bob"),
      requested: false,
      asCodeOwner: false,
      verdict: "approved" as const,
      verdictAt: null,
    };
    const reviewers = [bob];
    const request = requestReviewersPatch({ users: ["bob", "carol"], teams: ["o/core"] });
    const shown = request.apply(conversation({ reviewers }));
    expect(shown.reviewers.map((r) => r.requested)).toEqual([true, true, true]);
    expect(request.undo(shown).reviewers).toEqual(reviewers);

    const remove = removeReviewersPatch({ users: ["bob"], teams: [] });
    const removed = remove.apply(conversation({ reviewers: [{ ...bob, requested: true }] }));
    expect(removed.reviewers).toEqual(reviewers);
  });

  it("doesn't duplicate a label already on the PR", () => {
    const label = { name: "api", color: "0e8a16", description: null };
    const patch = addLabelsPatch([label]);
    const shown = patch.apply(conversation({ labels: [label] }));
    expect(shown.labels).toEqual([label]);
    expect(patch.undo(shown).labels).toEqual([label]);
  });
});
