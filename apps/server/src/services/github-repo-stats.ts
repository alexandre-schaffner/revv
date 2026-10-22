import { Effect } from "effect";
import type { GitHubError } from "../domain/errors";
import { githubFetch, githubFetchStatus, retryTransient } from "./github-rest";

/**
 * A repo statistic from GitHub's `/stats/*` endpoints. GitHub computes these
 * lazily: the first request for a repo answers 202 and kicks off the job, so
 * `computing` means "ask again shortly". `unavailable` is its 422 for repos
 * too large to compute the statistic (10,000+ commits, for code frequency).
 */
export type RepoStat<T> =
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "computing" }
  | { readonly kind: "unavailable" };

export interface CommitActivityWeek {
  readonly week: number;
  readonly days: readonly number[];
}

/** One week of `/stats/code_frequency`: Sunday (Unix seconds), additions, deletions (negative). */
export type CodeFrequencyWeek = readonly [week: number, additions: number, deletions: number];

export interface PrSearchPage {
  readonly total: number;
  readonly items: ReadonlyArray<{
    readonly number: number;
    readonly authorLogin: string;
    readonly createdAt: string;
    readonly mergedAt: string | null;
  }>;
}

function fetchRepoStat<W>(
  path: string,
  token: string,
  apiBase: string,
): Effect.Effect<RepoStat<readonly W[]>, GitHubError> {
  return githubFetchStatus(path, token, apiBase, [422]).pipe(
    Effect.map(({ status, body }): RepoStat<readonly W[]> => {
      if (status === 202) return { kind: "computing" };
      if (status === 422) return { kind: "unavailable" };
      // 204 is an empty repository.
      if (status === 204) return { kind: "ready", data: [] };
      return Array.isArray(body) ? { kind: "ready", data: body } : { kind: "computing" };
    }),
  );
}

export function getCommitActivity(
  fullName: string,
  token: string,
  apiBase: string,
): Effect.Effect<RepoStat<readonly CommitActivityWeek[]>, GitHubError> {
  return fetchRepoStat<CommitActivityWeek>(
    `/repos/${fullName}/stats/commit_activity`,
    token,
    apiBase,
  );
}

export function getCodeFrequency(
  fullName: string,
  token: string,
  apiBase: string,
): Effect.Effect<RepoStat<readonly CodeFrequencyWeek[]>, GitHubError> {
  return fetchRepoStat<CodeFrequencyWeek>(
    `/repos/${fullName}/stats/code_frequency`,
    token,
    apiBase,
  );
}

export function searchPullRequests(
  fullName: string,
  qualifiers: string,
  token: string,
  apiBase: string,
): Effect.Effect<PrSearchPage, GitHubError> {
  const q = `repo:${fullName} is:pr ${qualifiers}`;
  const params = new URLSearchParams({ q, per_page: "100", sort: "created", order: "desc" });
  return githubFetch(`/search/issues?${params.toString()}`, token, apiBase).pipe(
    Effect.map((raw): PrSearchPage => {
      const body = (raw ?? {}) as { total_count?: unknown; items?: unknown };
      const items: PrSearchPage["items"][number][] = [];
      for (const entry of Array.isArray(body.items) ? body.items : []) {
        if (entry === null || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const user = item.user as Record<string, unknown> | null | undefined;
        const prMeta = item.pull_request as Record<string, unknown> | null | undefined;
        if (typeof item.number !== "number" || typeof item.created_at !== "string") continue;
        items.push({
          number: item.number,
          authorLogin: typeof user?.login === "string" ? user.login : "",
          createdAt: item.created_at,
          mergedAt: typeof prMeta?.merged_at === "string" ? prMeta.merged_at : null,
        });
      }
      const total = typeof body.total_count === "number" ? body.total_count : items.length;
      return { total, items };
    }),
    retryTransient,
  );
}
