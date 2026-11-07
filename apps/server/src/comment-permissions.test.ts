import { describe, expect, it } from "bun:test";
import { canUserModifyComment, isPublishableDraftComment } from "@revv/shared";

const draft = {
  authorRole: "reviewer" as const,
  authorLogin: "Alex",
  externalId: null,
};

describe("canUserModifyComment", () => {
  it("allows the active user's draft regardless of login casing", () => {
    expect(canUserModifyComment(draft, "alex")).toBe(true);
  });

  it("allows Revv-authored drafts", () => {
    expect(
      canUserModifyComment({ authorRole: "ai_agent", authorLogin: null, externalId: null }, "alex"),
    ).toBe(true);
  });

  it("rejects another user's draft and every GitHub-backed comment", () => {
    expect(canUserModifyComment(draft, "marie")).toBe(false);
    expect(canUserModifyComment({ ...draft, externalId: "42" }, "alex")).toBe(false);
  });
});

describe("isPublishableDraftComment", () => {
  it("includes Revv-authored drafts in GitHub reviews", () => {
    expect(
      isPublishableDraftComment(
        {
          authorRole: "ai_agent",
          authorLogin: null,
          externalId: null,
          body: "A concrete review concern",
        },
        "alex",
      ),
    ).toBe(true);
  });

  it("includes the viewer's drafts whatever their role, the PR author's own included", () => {
    expect(isPublishableDraftComment({ ...draft, body: "Concern" }, "alex")).toBe(true);
    expect(
      isPublishableDraftComment({ ...draft, authorRole: "coder", body: "Concern" }, "alex"),
    ).toBe(true);
  });

  it("rejects empty, synced, another user's and an external agent's messages", () => {
    expect(isPublishableDraftComment({ ...draft, body: "  " }, "alex")).toBe(false);
    expect(isPublishableDraftComment({ ...draft, externalId: "42", body: "Concern" }, "alex")).toBe(
      false,
    );
    expect(isPublishableDraftComment({ ...draft, body: "Concern" }, "marie")).toBe(false);
    expect(
      isPublishableDraftComment(
        { authorRole: "coder", authorLogin: null, externalId: null, body: "Done" },
        "alex",
      ),
    ).toBe(false);
  });
});
