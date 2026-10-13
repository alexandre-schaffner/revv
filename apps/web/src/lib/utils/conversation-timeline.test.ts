import { describe, expect, it } from "bun:test";
import type { ConversationActor, TimelineItem } from "@revv/shared";
import { groupTimeline } from "./conversation-timeline";

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
