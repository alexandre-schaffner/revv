import { Effect } from "effect";
import type { GitHubError } from "../../domain/errors";
import { type GitHubClient, type GitHubHttp, retryTransient } from "./transport";

export interface GitHubViewer {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly avatarUrl: string | null;
}

export const usersApi = (http: GitHubHttp) => ({
  /**
   * `GET /user`, never from the ETag cache: GitHub Enterprise's signed
   * `avatar_url` rotates without changing the ETag, so a 304 would replay an
   * expired avatar URL.
   */
  viewer: (client: GitHubClient): Effect.Effect<GitHubViewer, GitHubError> =>
    http.json(client, { path: "/user" }).pipe(
      Effect.map((data) => {
        const raw = data as Record<string, unknown>;
        return {
          id: raw.id as number,
          login: raw.login as string,
          name: (raw.name as string | null | undefined) ?? null,
          email: (raw.email as string | null | undefined) ?? null,
          avatarUrl: (raw.avatar_url as string | null | undefined) ?? null,
        };
      }),
      retryTransient,
    ),

  /** The viewer's primary email, or null when the token can't read emails. */
  primaryEmail: (client: GitHubClient): Effect.Effect<string | null, GitHubError> =>
    http
      .json(client, { path: "/user/emails" })
      .pipe(
        Effect.map(
          (data) =>
            ((data ?? []) as Array<{ email: string; primary: boolean }>).find((e) => e.primary)
              ?.email ?? null,
        ),
      ),
});
