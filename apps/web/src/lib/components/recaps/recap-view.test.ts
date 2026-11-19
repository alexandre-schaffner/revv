import { describe, expect, it } from "bun:test";
import { EMPTY_RECAP_STATS, type ProjectRecap, type RecapPrEntry } from "@revv/shared";
import { groupRecapTopics, projectRecap } from "./recap-view";

function entry(id: string, theme: string, author: string, repo = "monorepo"): RecapPrEntry {
  return {
    id,
    recapId: "recap",
    prId: id,
    repositoryId: repo,
    position: Number(id),
    theme,
    verb: "changed",
    prTitle: theme,
    prExternalId: Number(id),
    prAuthorLogin: author,
    prAuthorAvatar: null,
    description: theme,
    linesAdded: 2,
    linesRemoved: 1,
    prState: "merged",
  };
}
const entries = [
  entry("1", "indexing", "Alex"),
  entry("2", "authentication", "sam"),
  entry("3", "authentication", "alex", "deployment"),
  entry("4", "foreign", "alex", "another-org"),
];
const recap: ProjectRecap = {
  id: "recap",
  repositoryId: "monorepo",
  sourceScope: {
    key: "all",
    kind: "all",
    label: "Everything",
    accountId: "account",
    repositoryIds: ["monorepo", "deployment", "another-org"],
    teams: [
      {
        org: "Merkl",
        slug: "all",
        name: "Everyone",
        memberLogins: ["alex", "sam", "pat"],
        repositoryIds: ["monorepo", "deployment"],
      },
      {
        org: "Merkl",
        slug: "engine",
        name: "Engine",
        memberLogins: ["alex"],
        repositoryIds: ["monorepo", "deployment"],
      },
      {
        org: "Merkl",
        slug: "rnd",
        name: "R&D",
        memberLogins: ["sam"],
        repositoryIds: ["monorepo", "deployment"],
      },
      {
        org: "Merkl",
        slug: "empty",
        name: "Empty",
        memberLogins: ["absent"],
        repositoryIds: ["monorepo"],
      },
    ],
  },
  period: "weekly",
  periodStart: "2026-10-19T00:00:00.000Z",
  periodEnd: "2026-10-26T00:00:00.000Z",
  lede: "Global overview",
  totalLinesAdded: 8,
  totalLinesRemoved: 4,
  entries,
  themeSummaries: ["indexing", "authentication", "foreign"].map((theme) => ({
    id: theme,
    recapId: "recap",
    theme,
    summary: `${theme} summary`,
    context: `${theme} context`,
    approach: `${theme} approach`,
    currentState: "Under review",
    worthWatching:
      theme === "authentication"
        ? "If login fails, check the changed OAuth client configuration."
        : "",
  })),
  status: "complete",
  supersededBy: null,
  generatedAt: "2026-10-26T00:00:00.000Z",
  completedAt: null,
  modelUsed: null,
  sourcePrIds: entries.map((entry) => entry.prId),
  sourceWalkthroughIds: [],
  summaryStats: EMPTY_RECAP_STATS,
  errorMessage: null,
};

describe("views of one generated recap", () => {
  it("reuses the exact topic explanations and watchpoints without changing the source recap", () => {
    const filtered = projectRecap(recap, { org: "MERKL", team: "ENGINE" });
    expect(filtered.id).toBe(recap.id);
    expect(filtered.entries.map((entry) => entry.prId)).toEqual(["1", "3"]);
    expect(filtered.themeSummaries).toEqual(recap.themeSummaries.slice(0, 2));
    expect(filtered.themeSummaries[1]).toBe(recap.themeSummaries[1]);
    expect(filtered.lede).not.toContain("foreign");
    expect(recap.entries).toHaveLength(4);
    expect(projectRecap(recap, {})).toBe(recap);
  });
  it("filters repositories independently of the anchor and retains cross-repository context", () => {
    const filtered = projectRecap(recap, { repoId: "deployment" });
    expect(filtered.entries.map((entry) => entry.prId)).toEqual(["3"]);
    expect(filtered.themeSummaries).toEqual(recap.themeSummaries.slice(1, 2));
    expect(filtered.themeSummaries[0]?.worthWatching).toContain("OAuth");
  });
  it("keeps other organizations out even when authors have the same login", () => {
    const filtered = projectRecap(recap, { org: "merkl", team: "engine" });
    expect(filtered.entries.some((entry) => entry.theme === "foreign")).toBe(false);
  });
  it("omits empty and umbrella teams and shows shared topics under their contributors", () => {
    const sections = groupRecapTopics(recap);
    expect(sections.find((section) => section.name === "Engine")?.themes).toEqual([
      "indexing",
      "authentication",
    ]);
    expect(sections.find((section) => section.name === "R&D")?.themes).toEqual(["authentication"]);
    expect(sections.some((section) => section.name === "Empty")).toBe(false);
    expect(sections.some((section) => section.name === "Everyone")).toBe(false);
    expect(sections.some((section) => section.key === "across-teams")).toBe(false);
    expect(
      sections.find((section) => section.name === "Engine")?.teamsByTheme.get("authentication"),
    ).toEqual(["Merkl / Engine", "Merkl / R&D"]);
    expect(sections.flatMap((section) => section.themes).sort()).toEqual([
      "authentication",
      "authentication",
      "foreign",
      "indexing",
    ]);
    expect(
      groupRecapTopics(projectRecap(recap, { org: "merkl", team: "rnd" }), {
        org: "merkl",
        team: "rnd",
      }).map((section) => section.name),
    ).toEqual(["R&D"]);
  });
  it("does not let an umbrella team win by collecting PRs across specific teams", () => {
    const engineEntry = entry("1", "shared work", "alex");
    const rndEntry = entry("2", "shared work", "sam");
    const multiTeamRecap = {
      ...recap,
      entries: [engineEntry, rndEntry],
    };
    const sections = groupRecapTopics(multiTeamRecap);
    expect(sections.map((section) => section.name)).toEqual(["Engine", "R&D"]);
    expect(
      sections.find((section) => section.name === "Engine")?.entriesByTheme.get("shared work"),
    ).toEqual([engineEntry]);
    expect(
      sections.find((section) => section.name === "R&D")?.entriesByTheme.get("shared work"),
    ).toEqual([rndEntry]);
    expect(multiTeamRecap.entries).toHaveLength(2);
  });
  it("keeps overlapping memberships ambiguous instead of breaking a tie by team size or name", () => {
    const teams = [
      {
        org: "Merkl",
        slug: "a",
        name: "A",
        memberLogins: ["ALEX", "sam"],
        repositoryIds: ["monorepo"],
      },
      {
        org: "Merkl",
        slug: "b",
        name: "B",
        memberLogins: ["alex", "pat", "kim"],
        repositoryIds: ["monorepo"],
      },
    ];
    const sections = groupRecapTopics(
      { ...recap, entries: [entry("1", "overlap", "Alex")] },
      {},
      teams,
    );
    expect(sections.map((section) => section.name)).toEqual(["A", "B"]);
    for (const section of sections) {
      expect(section.entriesByTheme.get("overlap")?.map((entry) => entry.prAuthorLogin)).toEqual([
        "Alex",
      ]);
      expect(section.teamsByTheme.get("overlap")).toEqual(["Merkl / A", "Merkl / B"]);
    }
  });
  it("preserves real GitHub team names and honors an explicitly selected umbrella team", () => {
    const teams =
      recap.sourceScope?.teams?.map((team) =>
        team.slug === "all" ? { ...team, name: "Mixed Team" } : team,
      ) ?? [];
    const filtered = projectRecap(recap, { org: "Merkl", team: "all" });
    const [section] = groupRecapTopics(filtered, { org: "Merkl", team: "all" }, teams);
    expect(section?.name).toBe("Mixed Team");
    expect(section?.themes).toEqual(["indexing", "authentication"]);
  });
  it("keeps unmatched authors separate without inventing a team", () => {
    const [section] = groupRecapTopics({ ...recap, entries: [entry("1", "automation", "bot")] });
    expect(section?.name).toBe("No matching team");
    expect(section?.teamsByTheme.get("automation")).toEqual([]);
    expect(section?.entriesByTheme.get("automation")?.map((entry) => entry.prAuthorLogin)).toEqual([
      "bot",
    ]);
  });
  it("does not mix unattributed work into a matched team's shared topic", () => {
    const known = entry("1", "shared work", "alex");
    const unknown = entry("2", "shared work", "bot");
    const sections = groupRecapTopics({ ...recap, entries: [known, unknown] });
    expect(
      sections.find((section) => section.name === "Engine")?.entriesByTheme.get("shared work"),
    ).toEqual([known]);
    expect(
      sections.find((section) => section.key === "other")?.entriesByTheme.get("shared work"),
    ).toEqual([unknown]);
    expect(
      new Set(
        sections.flatMap((section) =>
          [...section.entriesByTheme.values()].flat().map((entry) => entry.id),
        ),
      ).size,
    ).toBe(2);
  });
  it("uses only the selected repository's contributions when grouping a filtered recap", () => {
    const sections = groupRecapTopics(projectRecap(recap, { repoId: "deployment" }));
    expect(sections.map((section) => section.name)).toEqual(["Engine"]);
    expect(sections[0]?.entriesByTheme.get("authentication")?.map((entry) => entry.prId)).toEqual([
      "3",
    ]);
  });
  it("returns an honest empty scope and supports older repository recaps", () => {
    expect(projectRecap(recap, { repoId: "absent" }).entries).toEqual([]);
    expect(groupRecapTopics(projectRecap(recap, { org: "merkl", team: "empty" }))).toEqual([]);
    const legacy = {
      ...recap,
      sourceScope: null,
      entries: [{ ...entry("1", "indexing", "Alex"), repositoryId: "" }],
    };
    expect(projectRecap(legacy, { repoId: "monorepo" }).entries).toHaveLength(1);
  });
});
