// The REST writes the Conversation tab makes: reviewers, assignees, labels,
// conversation comments, the PR description, and Actions re-runs.

import { Effect } from "effect";
import { type GitHubError, GitHubNotFoundError } from "../../domain/errors";
import { githubDelete, githubPatch, githubPost } from "../github-rest";
import type { RepoRef } from "./github";

function prPath(ref: RepoRef, number: number): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls/${number}`;
}

function issuePath(ref: RepoRef, number: number): string {
  return `/repos/${ref.owner}/${ref.repo}/issues/${number}`;
}

export interface ReviewerChange {
  readonly users: readonly string[];
  readonly teams: readonly string[];
}

/** Team slugs travel as `org/slug` in Revv; REST wants the bare slug. */
function bareTeamSlugs(teams: readonly string[]): string[] {
  return teams.map((t) => t.split("/").pop() ?? t);
}

export function requestReviewers(
  ref: RepoRef,
  number: number,
  change: ReviewerChange,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubPost(
    `${prPath(ref, number)}/requested_reviewers`,
    token,
    { reviewers: change.users, team_reviewers: bareTeamSlugs(change.teams) },
    apiBase,
  ).pipe(Effect.asVoid);
}

export function removeReviewers(
  ref: RepoRef,
  number: number,
  change: ReviewerChange,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubDeleteWithBody(
    `${prPath(ref, number)}/requested_reviewers`,
    { reviewers: change.users, team_reviewers: bareTeamSlugs(change.teams) },
    token,
    apiBase,
  );
}

export function addAssignees(
  ref: RepoRef,
  number: number,
  logins: readonly string[],
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubPost(
    `${issuePath(ref, number)}/assignees`,
    token,
    { assignees: logins },
    apiBase,
  ).pipe(Effect.asVoid);
}

export function removeAssignees(
  ref: RepoRef,
  number: number,
  logins: readonly string[],
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubDeleteWithBody(
    `${issuePath(ref, number)}/assignees`,
    { assignees: logins },
    token,
    apiBase,
  );
}

export function addLabels(
  ref: RepoRef,
  number: number,
  names: readonly string[],
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubPost(`${issuePath(ref, number)}/labels`, token, { labels: names }, apiBase).pipe(
    Effect.asVoid,
  );
}

export function removeLabel(
  ref: RepoRef,
  number: number,
  name: string,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubDelete(
    `${issuePath(ref, number)}/labels/${encodeURIComponent(name)}`,
    token,
    apiBase,
  ).pipe(
    // Already gone is the outcome the caller wanted.
    Effect.catchIf(
      (e) => e instanceof GitHubNotFoundError,
      () => Effect.void,
    ),
    Effect.asVoid,
  );
}

export function postIssueComment(
  ref: RepoRef,
  number: number,
  body: string,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubPost(`${issuePath(ref, number)}/comments`, token, { body }, apiBase).pipe(
    Effect.asVoid,
  );
}

export function editIssueComment(
  ref: RepoRef,
  commentId: number,
  body: string,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubPatch(
    `/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`,
    token,
    { body },
    apiBase,
  ).pipe(Effect.asVoid);
}

export function deleteIssueComment(
  ref: RepoRef,
  commentId: number,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubDelete(
    `/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`,
    token,
    apiBase,
  ).pipe(Effect.asVoid);
}

export function editPrBody(
  ref: RepoRef,
  number: number,
  body: string,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubPatch(prPath(ref, number), token, { body }, apiBase).pipe(Effect.asVoid);
}

export function rerunFailedJobs(
  ref: RepoRef,
  runId: number,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubPost(
    `/repos/${ref.owner}/${ref.repo}/actions/runs/${runId}/rerun-failed-jobs`,
    token,
    {},
    apiBase,
  ).pipe(Effect.asVoid);
}

export function rerunJob(
  ref: RepoRef,
  jobId: number,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubPost(
    `/repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}/rerun`,
    token,
    {},
    apiBase,
  ).pipe(Effect.asVoid);
}

function githubDeleteWithBody(
  path: string,
  body: Record<string, unknown>,
  token: string,
  apiBase: string,
): Effect.Effect<void, GitHubError> {
  return githubDelete(path, token, apiBase, body).pipe(Effect.asVoid);
}
