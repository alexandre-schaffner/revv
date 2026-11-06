import type { Repository } from "@revv/shared";

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

/** `owner/name`, the only shape the add-repo flow accepts as a typed slug. */
export function isRepoSlug(value: string): boolean {
  return REPO_SLUG.test(value);
}

/** GitHub treats owner and repository names case-insensitively. */
export function repoKey(fullName: string): string {
  return fullName.toLowerCase();
}

export function indexByFullName<T extends { fullName: string }>(
  repos: readonly T[],
): Map<string, T> {
  return new Map(repos.map((repo) => [repoKey(repo.fullName), repo]));
}

export function filterRepos<T extends Pick<Repository, "fullName" | "owner" | "name">>(
  repos: readonly T[],
  query: string,
): readonly T[] {
  const term = query.trim().toLowerCase();
  if (!term) return repos;
  return repos.filter(
    (repo) =>
      repo.fullName.toLowerCase().includes(term) ||
      repo.owner.toLowerCase().includes(term) ||
      repo.name.toLowerCase().includes(term),
  );
}

/** Groups by owner case-insensitively; each group is labelled by its first repo's owner. */
export function groupByOwner<T extends Pick<Repository, "owner">>(
  repos: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  const labels = new Map<string, string>();
  for (const repo of repos) {
    const key = repo.owner.toLowerCase();
    const label = labels.get(key) ?? repo.owner;
    labels.set(key, label);
    const group = groups.get(label);
    if (group) group.push(repo);
    else groups.set(label, [repo]);
  }
  return groups;
}

export function majorityOwner(repos: readonly Pick<Repository, "owner">[]): string | null {
  const counts = new Map<string, number>();
  for (const repo of repos) counts.set(repo.owner, (counts.get(repo.owner) ?? 0) + 1);
  let top: string | null = null;
  let topCount = 0;
  for (const [owner, count] of counts) {
    if (count > topCount) {
      top = owner;
      topCount = count;
    }
  }
  return top !== null && topCount > repos.length / 2 ? top : null;
}
