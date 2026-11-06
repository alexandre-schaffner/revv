import { describe, expect, it } from "bun:test";
import type { ConversationActor, TimelineItem } from "@revv/shared";
import { describeEvent, type EventLine, groupTimeline, type Phrase } from "./timeline";

const actor = (login: string): ConversationActor => ({
  login,
  name: null,
  avatarContent: null,
  kind: "user",
});

const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, "0")}:00Z`;

const commit = (id: string, minute: number): TimelineItem => ({
  kind: "commit",
  id,
  createdAt: at(minute),
  sha: id,
  headline: id,
  messageBody: "",
  author: actor("alice"),
  url: "",
  verified: null,
  ci: null,
});

const label = (id: string, login: string, minute: number, name: string): TimelineItem => ({
  kind: "labeled",
  id,
  createdAt: at(minute),
  actor: actor(login),
  label: { name, color: "ededed", description: null },
});

describe("groupTimeline", () => {
  it("runs consecutive commits into one block", () => {
    const rows = groupTimeline([commit("a", 0), commit("b", 1), commit("c", 2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "commits" && rows[0].commits.map((c) => c.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("merges a burst of labels by one actor into one line", () => {
    const rows = groupTimeline([
      label("l1", "bot", 0, "api"),
      label("l2", "bot", 1, "core"),
      label("l3", "alice", 1, "ux"),
      label("l4", "bot", 30, "late"),
    ]);
    expect(rows).toHaveLength(1);
    const lines = rows[0]?.kind === "events" ? rows[0].lines : [];
    expect(lines.map((l) => (l.kind === "labels" ? l.added.map((x) => x.name) : []))).toEqual([
      ["api", "core"],
      ["ux"],
      ["late"],
    ]);
  });

  it("lets a comment split runs", () => {
    const rows = groupTimeline([
      commit("a", 0),
      {
        kind: "comment",
        id: "c1",
        createdAt: at(1),
        databaseId: 1,
        author: actor("bob"),
        body: "hi",
        edited: false,
        url: "",
        viewerCanUpdate: false,
        viewerCanDelete: false,
      },
      commit("b", 2),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["commits", "comment", "commits"]);
  });

  it("merges review requests made together", () => {
    const rows = groupTimeline([
      {
        kind: "review_requested",
        id: "r1",
        createdAt: at(0),
        actor: actor("alice"),
        reviewer: "bob",
        reviewerIsTeam: false,
      },
      {
        kind: "review_requested",
        id: "r2",
        createdAt: at(0),
        actor: actor("alice"),
        reviewer: "org/core",
        reviewerIsTeam: true,
      },
    ]);
    const line = rows[0]?.kind === "events" ? rows[0].lines[0] : null;
    expect(line?.kind === "review_requests" && line.requested).toEqual(["bob", "org/core"]);
  });

  it("names a label once when it was added, removed, and added again", () => {
    const unlabel = (id: string, minute: number, name: string): TimelineItem => ({
      kind: "unlabeled",
      id,
      createdAt: at(minute),
      actor: actor("alice"),
      label: { name, color: "ededed", description: null },
    });
    const rows = groupTimeline([
      label("l1", "alice", 0, "api"),
      unlabel("l2", 0, "api"),
      label("l3", "alice", 1, "api"),
    ]);
    const line = rows[0]?.kind === "events" ? rows[0].lines[0] : null;
    expect(line?.kind === "labels" && line.added.map((l) => l.name)).toEqual(["api"]);
    expect(line?.kind === "labels" && line.removed.map((l) => l.name)).toEqual(["api"]);
  });
});

/** The sentence as it reads on screen, label chips by name. */
function sentence(phrases: readonly Phrase[]): string {
  return phrases
    .map((p) => (p.kind === "labels" ? p.labels.map((l) => `[${l.name}]`).join(" ") : p.text))
    .join(" ");
}

function lineOf(items: TimelineItem[]): EventLine {
  const row = groupTimeline(items)[0];
  if (row?.kind !== "events" || !row.lines[0]) throw new Error("expected an event line");
  return row.lines[0];
}

describe("describeEvent", () => {
  it("reads a label burst as one sentence", () => {
    const line = lineOf([label("l1", "alice", 0, "api"), label("l2", "alice", 1, "bug")]);
    const described = describeEvent(line, "alice");
    expect(described.icon).toBe("labels");
    expect(sentence(described.phrases)).toBe("added [api] [bug] labels");
  });

  it("says self-assigned whatever the login's case", () => {
    const line = lineOf([
      {
        kind: "assigned",
        id: "a1",
        createdAt: at(0),
        actor: actor("Alice"),
        assignee: "alice",
      },
    ]);
    expect(sentence(describeEvent(line, "Alice").phrases)).toBe("self-assigned this");
  });

  it("colours state changes the way GitHub does", () => {
    const merged = lineOf([
      {
        kind: "merged",
        id: "m1",
        createdAt: at(0),
        actor: actor("alice"),
        commitSha: "0123456789abcdef",
        baseRef: "main",
      },
    ]);
    const described = describeEvent(merged, "alice");
    expect(described.tone).toBe("merged");
    expect(sentence(described.phrases)).toBe("merged 0123456 into main");
  });
});
