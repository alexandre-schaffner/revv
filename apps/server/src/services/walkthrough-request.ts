// ── Walkthrough request at a known head ─────────────────────────────────────
//
// The orchestrator side of the external `request_walkthrough` tool: an agent
// outside Revv pushes commits and asks for a fresh review of exactly the head
// it pushed. That agent cannot name a walkthrough row or a lifecycle state —
// it hands over a commit, and everything else goes through
// `WalkthroughJobs.startJob`, pinned to that head (`expectedHeadSha`).
//
// Idempotent on the head: a completed review at that head is returned as-is,
// and a job already generating it is joined, so a retried (or recursive) call
// never starts a second run.
//
// Bounded, because the caller is a loop: a run the user stopped is never
// restarted from here, and every head and every PR has a run budget. Both read
// the journal, so they hold across restarts; they count every run, whoever
// started it — a head the user already retried three times is not one an
// agent should spend more on.

import type { WalkthroughGenerationMode, WalkthroughMode } from "@revv/shared";
import { and, desc, eq, gt } from "drizzle-orm";
import { Effect } from "effect";
import { walkthroughs } from "../db/schema/walkthroughs";
import { DbError } from "../domain/errors";
import { DbService } from "./Db";
import { resolveReviewModeForPr } from "./review-mode";
import {
  type StartJobError,
  WALKTHROUGH_CANCELLED_MESSAGE,
  WalkthroughJobs,
} from "./WalkthroughJobs";

/** Runs (of any status) at one head before `request_walkthrough` stops starting more. */
export const MAX_RUNS_PER_HEAD = 3;
/** Runs started on one PR within an hour before `request_walkthrough` stops starting more. */
export const MAX_RUNS_PER_PR_PER_HOUR = 6;
const HOUR_MS = 60 * 60 * 1000;

export type WalkthroughRequestOutcome =
  | {
      readonly kind: "started" | "joined" | "already_complete";
      readonly walkthroughId: string;
      readonly headSha: string;
      readonly mode: WalkthroughMode;
    }
  | WalkthroughRequestRefusal;

/** Nothing was started; the agent is told why. */
export type WalkthroughRequestRefusal =
  /** GitHub has not seen the requested head (yet). */
  | { readonly kind: "head_mismatch"; readonly githubHeadSha: string }
  /** The user stopped Revv's run at this head; restarting it is theirs to do. */
  | { readonly kind: "stopped_by_user"; readonly walkthroughId: string }
  /** A run budget is spent. */
  | {
      readonly kind: "budget_exhausted";
      readonly scope: "head" | "pr_hour";
      readonly runs: number;
    };

export type WalkthroughRequestError =
  | Exclude<StartJobError, { _tag: "HeadShaMismatchError" }>
  | DbError;

export const requestWalkthroughAtHead = (params: {
  readonly prId: string;
  readonly userId: string;
  /** Lowercase, 40 hex characters. */
  readonly headSha: string;
  readonly generationMode: WalkthroughGenerationMode;
}): Effect.Effect<
  WalkthroughRequestOutcome,
  WalkthroughRequestError,
  DbService | WalkthroughJobs
> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const jobs = yield* WalkthroughJobs;
    const { headSha } = params;
    // The mode the PR's review page reads: a review the agent asks for must
    // land in the session the user actually sees (`author` on their own PR).
    // An unresolved verdict is still the right answer to write under: the web
    // falls back to the same `reviewer` while identity is unknown.
    const { mode } = yield* resolveReviewModeForPr(params.prId);

    const runsAtHead = yield* Effect.try({
      try: () =>
        db
          .select({
            id: walkthroughs.id,
            status: walkthroughs.status,
            errorMessage: walkthroughs.errorMessage,
          })
          .from(walkthroughs)
          .where(
            and(
              eq(walkthroughs.pullRequestId, params.prId),
              eq(walkthroughs.prHeadSha, headSha),
              eq(walkthroughs.mode, mode),
            ),
          )
          .orderBy(desc(walkthroughs.generatedAt))
          .all(),
      catch: (cause) => new DbError({ message: "requestWalkthroughAtHead: runs at head", cause }),
    });

    const complete = runsAtHead.find((row) => row.status === "complete");
    if (complete) {
      return { kind: "already_complete", walkthroughId: complete.id, headSha, mode };
    }

    const latest = runsAtHead[0];
    if (latest?.status === "error" && latest.errorMessage === WALKTHROUGH_CANCELLED_MESSAGE) {
      return { kind: "stopped_by_user", walkthroughId: latest.id };
    }

    // A generating row is joined (or resumed) by `startJob`, which starts no
    // new run, so it is never refused for budget.
    if (latest?.status !== "generating") {
      if (runsAtHead.length >= MAX_RUNS_PER_HEAD) {
        return { kind: "budget_exhausted", scope: "head", runs: runsAtHead.length };
      }
      const since = new Date(Date.now() - HOUR_MS).toISOString();
      const runsThisHour = yield* Effect.try({
        try: () =>
          db
            .select({ id: walkthroughs.id })
            .from(walkthroughs)
            .where(
              and(
                eq(walkthroughs.pullRequestId, params.prId),
                eq(walkthroughs.mode, mode),
                gt(walkthroughs.generatedAt, since),
              ),
            )
            .all().length,
        catch: (cause) =>
          new DbError({ message: "requestWalkthroughAtHead: runs this hour", cause }),
      });
      if (runsThisHour >= MAX_RUNS_PER_PR_PER_HOUR) {
        return { kind: "budget_exhausted", scope: "pr_hour", runs: runsThisHour };
      }
    }

    return yield* jobs
      .startJob({
        prId: params.prId,
        userId: params.userId,
        trigger: "external_agent",
        mode,
        generationMode: params.generationMode,
        expectedHeadSha: headSha,
      })
      .pipe(
        Effect.map(
          ({ walkthroughId, reused }): WalkthroughRequestOutcome => ({
            kind: reused ? "joined" : "started",
            walkthroughId,
            headSha,
            mode,
          }),
        ),
        Effect.catchTag("HeadShaMismatchError", (error) =>
          Effect.succeed<WalkthroughRequestOutcome>({
            kind: "head_mismatch",
            githubHeadSha: error.githubHeadSha,
          }),
        ),
      );
  });

/**
 * What an agent should read when a request fails. Several of these errors
 * carry no `message`, and the runtime's fallback ("An error has occurred")
 * tells the agent nothing about whether to retry.
 */
export function describeWalkthroughRequestError(error: WalkthroughRequestError): string {
  switch (error._tag) {
    case "CloneInProgressError":
      return "Revv is still cloning this repository. Retry in a minute.";
    case "CloneNotReadyError":
      return "Revv has not cloned this repository yet. Ask the user to check Revv's Settings.";
    case "AiNotConfiguredError":
      return "No AI agent is configured in Revv. Ask the user to pick one in Revv's Settings.";
    case "OpencodeNotSelectedError":
    case "OpencodeUnhealthyError":
      return "Revv's opencode daemon is not available. Retry in a minute, or ask the user to check Revv's Settings.";
    case "GitHubRateLimitError":
      return `GitHub rate-limited Revv until ${error.resetAt.toISOString()}. Retry after that.`;
    case "GitHubAuthError":
      return "Revv's GitHub sign-in is no longer valid. Ask the user to sign in again in Revv.";
    case "GitHubNetworkError":
      return "Revv could not reach GitHub. Retry in a minute.";
    case "GitHubApiError":
      return `GitHub rejected Revv's request (HTTP ${error.status}).`;
    case "GitHubNotFoundError":
    case "NotFoundError":
      return `Revv could not find ${error.resource} '${error.id}'.`;
    case "AiGenerationError":
      return error.message ?? "Walkthrough generation could not start.";
    case "GitHubAccessDeniedError":
    case "CloneError":
    case "ReviewError":
    case "ValidationError":
    case "DbError":
      return error.message;
  }
}
