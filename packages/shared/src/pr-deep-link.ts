export interface PullRequestLocator {
  readonly githubHost: string;
  readonly repositoryFullName: string;
  readonly number: number;
}

const REPOSITORY_FULL_NAME = /^[^/\s]+\/[^/\s]+$/;
const DECIMAL_INTEGER = /^[1-9]\d*$/;

function isValidGithubHost(value: string): boolean {
  if (value !== value.trim() || value.length === 0) return false;
  try {
    const parsed = new URL(`https://${value}`);
    return (
      parsed.hostname === value.toLowerCase() &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/"
    );
  } catch {
    return false;
  }
}

/** Parse an untrusted `revv://pr` URL into its provider identity. */
export function parsePullRequestDeepLink(value: string): PullRequestLocator | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "revv:" ||
    url.hostname !== "pr" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.hash !== ""
  ) {
    return null;
  }

  const allowedKeys = new Set(["host", "repo", "number"]);
  let hasUnknownKey = false;
  url.searchParams.forEach((_value, key) => {
    if (!allowedKeys.has(key)) hasUnknownKey = true;
  });
  if (hasUnknownKey) return null;

  const hosts = url.searchParams.getAll("host");
  const repositories = url.searchParams.getAll("repo");
  const numbers = url.searchParams.getAll("number");
  if (hosts.length !== 1 || repositories.length !== 1 || numbers.length !== 1) return null;

  const githubHost = hosts[0]?.toLowerCase() ?? "";
  const repositoryFullName = repositories[0] ?? "";
  const rawNumber = numbers[0] ?? "";
  if (!isValidGithubHost(githubHost) || !REPOSITORY_FULL_NAME.test(repositoryFullName)) {
    return null;
  }
  if (!DECIMAL_INTEGER.test(rawNumber)) return null;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  return { githubHost, repositoryFullName, number };
}

/** Build the stable, machine-independent URL copied by Revv. */
export function buildPullRequestDeepLink(locator: PullRequestLocator): string {
  const host = locator.githubHost.trim().toLowerCase();
  if (
    !isValidGithubHost(host) ||
    !REPOSITORY_FULL_NAME.test(locator.repositoryFullName) ||
    !Number.isSafeInteger(locator.number) ||
    locator.number <= 0
  ) {
    throw new TypeError("Invalid pull request locator");
  }
  const params = new URLSearchParams({
    host,
    repo: locator.repositoryFullName,
    number: String(locator.number),
  });
  return `revv://pr?${params.toString()}`;
}
