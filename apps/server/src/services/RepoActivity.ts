import type {
  RepoActivity,
  RepoActivityResponse,
  RepoActivityWeek,
  RepoPrFlow,
  Repository,
} from "@revv/shared";
import { Effect } from "effect";
import { logError } from "../logger";
import { CacheService } from "./Cache";
import { GitHubGateway } from "./GitHub";
import type {
  CodeFrequencyWeek,
  CommitActivityWeek,
  PrSearchPage,
  RepoStat,
} from "./github-repo-stats";
import { apiBaseForHost } from "./github-rest";

const REPO_ACTIVITY_NS = "repo-activity";
const REPO_ACTIVITY_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Code frequency can sit on 202 for minutes after commit activity is ready.
 * The heatmap ships without it, cached only this long so churn fills in on a
 * later visit.
 */
const PARTIAL_ACTIVITY_TTL_MS = 2 * 60 * 1000;

const REPO_PR_FLOW_NS = "repo-pr-flow";
const REPO_PR_FLOW_TTL_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Code frequency is optional: GitHub refuses it for repos with 10,000+
 * commits, can still be computing it, and the heatmap stands on its own
 * without it.
 */
export function buildRepoActivity(
  commits: readonly CommitActivityWeek[],
  churn: RepoStat<readonly CodeFrequencyWeek[]>,
  fetchedAt: Date,
): RepoActivity {
  const churnByWeek = new Map<number, CodeFrequencyWeek>(
    churn.kind === "ready" ? churn.data.map((w) => [w[0], w]) : [],
  );
  const weeks = commits.map((w): RepoActivityWeek => {
    const freq = churnByWeek.get(w.week);
    return {
      weekStart: new Date(w.week * 1000).toISOString().slice(0, 10),
      days: Array.from({ length: 7 }, (_, i) => w.days[i] ?? 0),
      additions: churn.kind === "ready" ? (freq?.[1] ?? 0) : null,
      deletions: churn.kind === "ready" ? Math.abs(freq?.[2] ?? 0) : null,
    };
  });
  return {
    status: "ready",
    weeks: padToYear(weeks, fetchedAt),
    fetchedAt: fetchedAt.toISOString(),
  };
}

/**
 * An empty repo answers with no weeks at all; still hand the client a full
 * year of zeroes so the heatmap draws its grid rather than nothing.
 */
function padToYear(weeks: RepoActivityWeek[], now: Date): RepoActivityWeek[] {
  if (weeks.length > 0) return weeks;
  const sunday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - now.getUTCDay(),
  );
  return Array.from({ length: 52 }, (_, i) => ({
    weekStart: new Date(sunday - (51 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
    days: [0, 0, 0, 0, 0, 0, 0],
    additions: null,
    deletions: null,
  }));
}

const getRepoActivity = (repo: Repository, token: string) =>
  Effect.gen(function* () {
    const cache = yield* CacheService;
    const github = yield* GitHubGateway;
    const key = `${repo.githubHost}:${repo.fullName}`;

    const cached = yield* cache.get<RepoActivity>(REPO_ACTIVITY_NS, key);
    if (cached) return cached;

    const apiBase = apiBaseForHost(repo.githubHost);
    const [commits, churn] = yield* Effect.all(
      [
        github.repos.commitActivity(repo.fullName, token, apiBase),
        github.repos.codeFrequency(repo.fullName, token, apiBase),
      ],
      { concurrency: 2 },
    );
    if (commits.kind === "computing") {
      return { status: "computing" } satisfies RepoActivity;
    }

    const activity = buildRepoActivity(
      commits.kind === "ready" ? commits.data : [],
      churn,
      new Date(),
    );
    yield* cache.set(REPO_ACTIVITY_NS, key, activity, {
      ttlMs: churn.kind === "computing" ? PARTIAL_ACTIVITY_TTL_MS : REPO_ACTIVITY_TTL_MS,
    });
    return activity;
  });

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function buildPrFlow(
  merged: PrSearchPage,
  opened: PrSearchPage,
  now: number,
  exactCounts: Partial<
    Pick<
      RepoPrFlow,
      "mergedLast7d" | "mergedPrev7d" | "openedLast7d" | "openedPrev7d" | "mergedPerWeek"
    >
  > = {},
): RepoPrFlow {
  const ageDays = (iso: string) => (now - Date.parse(iso)) / DAY_MS;
  const mergedAges = merged.items.flatMap((pr) => (pr.mergedAt ? [ageDays(pr.mergedAt)] : []));
  const openedAges = opened.items.map((pr) => ageDays(pr.createdAt));
  const within = (ages: number[], from: number, to: number) =>
    ages.filter((a) => a >= from && a < to).length;

  const mergeHours = merged.items.flatMap((pr) =>
    pr.mergedAt ? [(Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / HOUR_MS] : [],
  );
  return {
    mergedLast7d: exactCounts.mergedLast7d ?? within(mergedAges, 0, 7),
    mergedPrev7d: exactCounts.mergedPrev7d ?? within(mergedAges, 7, 14),
    openedLast7d: exactCounts.openedLast7d ?? within(openedAges, 0, 7),
    openedPrev7d: exactCounts.openedPrev7d ?? within(openedAges, 7, 14),
    medianHoursToMerge: median(mergeHours),
    medianSample: mergeHours.length,
    mergedLast28d: merged.total,
    authorsLast28d: new Set(merged.items.map((pr) => pr.authorLogin.toLowerCase()).filter(Boolean))
      .size,
    mergedPerWeek:
      exactCounts.mergedPerWeek ?? [21, 14, 7, 0].map((from) => within(mergedAges, from, from + 7)),
  };
}

const getRepoPrFlow = (repo: Repository, token: string) =>
  Effect.gen(function* () {
    const cache = yield* CacheService;
    const github = yield* GitHubGateway;
    const key = `${repo.githubHost}:${repo.fullName}`;
    const cached = yield* cache.get<RepoPrFlow>(REPO_PR_FLOW_NS, key);
    if (cached) return cached;

    const apiBase = apiBaseForHost(repo.githubHost);
    const now = Date.now();
    const day = (n: number) => isoDay(now - n * DAY_MS);
    const search = (qualifiers: string) =>
      github.repos.searchPullRequests(repo.fullName, qualifiers, token, apiBase);
    const count = (qualifiers: string) => Effect.map(search(qualifiers), (page) => page.total);

    const [merged, opened] = yield* Effect.all(
      [search(`is:merged merged:>=${day(28)}`), search(`created:>=${day(14)}`)],
      { concurrency: 2 },
    );
    const mergedWeeks =
      merged.total > merged.items.length
        ? yield* Effect.all(
            [
              count(`is:merged merged:${day(28)}..${day(22)}`),
              count(`is:merged merged:${day(21)}..${day(15)}`),
              count(`is:merged merged:${day(14)}..${day(8)}`),
              count(`is:merged merged:>=${day(7)}`),
            ],
            { concurrency: 2 },
          )
        : null;
    const exactCounts = {
      ...(mergedWeeks
        ? {
            mergedPerWeek: mergedWeeks,
            mergedLast7d: mergedWeeks[3] ?? 0,
            mergedPrev7d: mergedWeeks[2] ?? 0,
          }
        : {}),
      ...(opened.total > opened.items.length
        ? {
            openedLast7d: yield* count(`created:>=${day(7)}`),
            openedPrev7d: yield* count(`created:${day(14)}..${day(8)}`),
          }
        : {}),
    };

    const flow = buildPrFlow(merged, opened, now, exactCounts);
    yield* cache.set(REPO_PR_FLOW_NS, key, flow, { ttlMs: REPO_PR_FLOW_TTL_MS });
    return flow;
  });

export const getRepoActivityResponse = (repo: Repository, token: string) =>
  Effect.gen(function* () {
    const [commits, flow] = yield* Effect.all(
      [
        getRepoActivity(repo, token),
        getRepoPrFlow(repo, token).pipe(
          Effect.catch((e) =>
            Effect.sync(() => {
              logError("RepoActivity", `PR flow unavailable for ${repo.fullName}:`, e);
              return null;
            }),
          ),
        ),
      ],
      { concurrency: 2 },
    );
    return { commits, flow } satisfies RepoActivityResponse;
  });
