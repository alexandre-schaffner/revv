import type { ConversationWrite } from "@revv/shared";
import { Effect } from "effect";
import { type GitHubError, GitHubNotFoundError } from "../../domain/errors";
import type { RepoRef } from "./conversation";
import type { GitHubClient, GitHubHttp } from "./transport";

interface GitHubWriteRequest {
  readonly method: "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: Record<string, unknown>;
  /** A 404 means it's already gone, which is the outcome the caller wanted. */
  readonly okIfMissing?: boolean;
}

/** Team slugs travel as `org/slug` in Revv; REST wants the bare slug. */
function bareTeamSlugs(teams: readonly string[]): string[] {
  return teams.map((t) => t.split("/").pop() ?? t);
}

function requestsFor(ref: RepoRef, number: number, w: ConversationWrite): GitHubWriteRequest[] {
  const repo = `/repos/${ref.owner}/${ref.repo}`;
  const pr = `${repo}/pulls/${number}`;
  const issue = `${repo}/issues/${number}`;
  switch (w.kind) {
    case "request_reviewers":
    case "remove_reviewers":
      return [
        {
          method: w.kind === "request_reviewers" ? "POST" : "DELETE",
          path: `${pr}/requested_reviewers`,
          body: { reviewers: w.users, team_reviewers: bareTeamSlugs(w.teams) },
        },
      ];
    case "add_assignees":
    case "remove_assignees":
      return [
        {
          method: w.kind === "add_assignees" ? "POST" : "DELETE",
          path: `${issue}/assignees`,
          body: { assignees: w.logins },
        },
      ];
    case "add_labels":
      return [{ method: "POST", path: `${issue}/labels`, body: { labels: w.names } }];
    case "remove_labels":
      // REST removes one label per call; replacing the whole set instead
      // would race anyone else labelling the PR.
      return w.names.map((name) => ({
        method: "DELETE",
        path: `${issue}/labels/${encodeURIComponent(name)}`,
        okIfMissing: true,
      }));
    case "post_comment":
      return [{ method: "POST", path: `${issue}/comments`, body: { body: w.body } }];
    case "edit_comment":
      return [
        { method: "PATCH", path: `${repo}/issues/comments/${w.commentId}`, body: { body: w.body } },
      ];
    case "delete_comment":
      return [{ method: "DELETE", path: `${repo}/issues/comments/${w.commentId}` }];
    case "edit_body":
      return [{ method: "PATCH", path: pr, body: { body: w.body } }];
    case "rerun_failed":
      return w.runIds.map((runId) => ({
        method: "POST",
        path: `${repo}/actions/runs/${runId}/rerun-failed-jobs`,
        body: {},
      }));
    case "rerun_job":
      return [{ method: "POST", path: `${repo}/actions/jobs/${w.jobId}/rerun`, body: {} }];
  }
}

/** Apply a write on GitHub, one request at a time; the first failure stops it. */
export function runWrite(
  http: GitHubHttp,
  client: GitHubClient,
  ref: RepoRef,
  number: number,
  w: ConversationWrite,
): Effect.Effect<void, GitHubError> {
  return Effect.forEach(
    requestsFor(ref, number, w),
    (request) => {
      const sent = http.json(client, {
        method: request.method,
        path: request.path,
        ...(request.body !== undefined || request.method !== "DELETE"
          ? { body: request.body ?? {} }
          : {}),
      });
      return request.okIfMissing
        ? sent.pipe(
            Effect.catchIf(
              (e) => e instanceof GitHubNotFoundError,
              () => Effect.void,
            ),
          )
        : sent;
    },
    { discard: true },
  );
}
