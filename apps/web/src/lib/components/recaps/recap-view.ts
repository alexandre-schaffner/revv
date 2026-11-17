import type { ProjectRecap, RecapPrEntry, RecapSourceScope } from "@revv/shared";

export interface RecapViewFilter {
  repoId?: string;
  org?: string;
  team?: string;
}
type TeamSnapshot = NonNullable<RecapSourceScope["teams"]>[number];

function belongsToTeam(entry: RecapPrEntry, team: TeamSnapshot): boolean {
  return (
    Boolean(entry.repositoryId && team.repositoryIds.includes(entry.repositoryId)) &&
    team.memberLogins.some((login) => login.toLowerCase() === entry.prAuthorLogin.toLowerCase())
  );
}

/** Keep generated topic prose intact; narrow only its supporting evidence and visible topics. */
export function projectRecap(recap: ProjectRecap, filter: RecapViewFilter): ProjectRecap {
  if (!filter.repoId && !filter.team) return recap;
  const team = recap.sourceScope?.teams?.find(
    (team) =>
      team.org.toLowerCase() === filter.org?.toLowerCase() &&
      team.slug.toLowerCase() === filter.team?.toLowerCase(),
  );
  // An older team-only generation is already scoped and predates team snapshots.
  if (
    !filter.repoId &&
    !team &&
    recap.sourceScope?.kind === "team" &&
    recap.sourceScope.org?.toLowerCase() === filter.org?.toLowerCase() &&
    recap.sourceScope.teamSlug?.toLowerCase() === filter.team?.toLowerCase()
  )
    return recap;
  const entries = recap.entries.filter((entry) =>
    filter.repoId
      ? (entry.repositoryId || (!recap.sourceScope ? recap.repositoryId : "")) === filter.repoId
      : Boolean(team && belongsToTeam(entry, team)),
  );
  const themes = new Set(entries.map((entry) => entry.theme));
  const themeSummaries = recap.themeSummaries.filter((summary) => themes.has(summary.theme));
  // The global lede may describe other teams. The existing summaries supply the scoped overview.
  return {
    ...recap,
    entries,
    themeSummaries,
    lede: themeSummaries.map((summary) => summary.summary).join(" "),
  };
}

export interface RecapTeamSection {
  key: string;
  name: string;
  org: string;
  themes: string[];
  teamsByTheme: Map<string, string[]>;
  entriesByTheme: Map<string, RecapPrEntry[]>;
}

/** Shared topics appear in each contributing team with only that team's evidence. */
export function groupRecapTopics(
  recap: ProjectRecap,
  filter: RecapViewFilter = {},
  teams: readonly TeamSnapshot[] = recap.sourceScope?.teams ?? [],
): RecapTeamSection[] {
  const sections = new Map<string, RecapTeamSection>();
  const topics = [
    ...new Set(
      [...recap.entries].sort((a, b) => a.position - b.position).map((entry) => entry.theme),
    ),
  ];
  for (const theme of topics) {
    const evidence = recap.entries.filter((entry) => entry.theme === theme);
    const selectedTeam = filter.team ? `team:${filter.org}/${filter.team}` : undefined;
    const contributions = new Map<
      string,
      { team: TeamSnapshot | undefined; entries: RecapPrEntry[] }
    >();
    for (const entry of evidence) {
      const matches = teams.filter((team) => belongsToTeam(entry, team));
      const specificTeams = matches.filter((team) => {
        if (selectedTeam)
          return selectedTeam.toLowerCase() === `team:${team.org}/${team.slug}`.toLowerCase();
        const members = new Set(team.memberLogins.map((login) => login.toLowerCase()));
        return !matches.some((other) => {
          const otherMembers = new Set(other.memberLogins.map((login) => login.toLowerCase()));
          return (
            other.org.toLowerCase() === team.org.toLowerCase() &&
            otherMembers.size < members.size &&
            [...otherMembers].every((login) => members.has(login))
          );
        });
      });
      const matchingTeams: (TeamSnapshot | undefined)[] = specificTeams.length
        ? specificTeams
        : [undefined];
      for (const team of matchingTeams) {
        const key = team ? `${team.org.toLowerCase()}/${team.slug.toLowerCase()}` : "other";
        const contribution = contributions.get(key) ?? { team, entries: [] };
        contribution.entries.push(entry);
        contributions.set(key, contribution);
      }
    }
    const teamNames = [...contributions.values()]
      .flatMap(({ team }) => (team ? [`${team.org} / ${team.name}`] : []))
      .sort();
    for (const [key, { team, entries }] of contributions) {
      const section = sections.get(key) ?? {
        key,
        name: team?.name ?? "No matching team",
        org: team?.org ?? "",
        themes: [],
        teamsByTheme: new Map<string, string[]>(),
        entriesByTheme: new Map<string, RecapPrEntry[]>(),
      };
      section.themes.push(theme);
      section.teamsByTheme.set(theme, teamNames);
      section.entriesByTheme.set(theme, entries);
      sections.set(key, section);
    }
  }
  return [...sections.values()].sort((a, b) =>
    a.key === "other" ? 1 : b.key === "other" ? -1 : a.name.localeCompare(b.name),
  );
}
