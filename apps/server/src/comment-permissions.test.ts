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
      isPublishableDraftComment({
        authorRole: "ai_agent",
        authorLogin: null,
        externalId: null,
        body: "A concrete review concern",
      }),
    ).toBe(true);
  });

  it("rejects empty, synced, and coder-authored messages", () => {
    expect(isPublishableDraftComment({ ...draft, body: "  " })).toBe(false);
    expect(isPublishableDraftComment({ ...draft, externalId: "42", body: "Concern" })).toBe(false);
    expect(
      isPublishableDraftComment({
        ...draft,
        authorRole: "coder",
        body: "Concern",
      }),
    ).toBe(false);
  });
});
