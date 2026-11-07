// Created when WalkthroughJobs launches a run, reached by the MCP route through
// the run's token, and dropped with the run. Everything here is a
// reconstructible cache (invariant 1): the background-judgment tracker, the
// prose-voice mailbox and the tool context built over them.

import type {
  ThreadEventMessage,
  WalkthroughMode,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { ZERO_TOKEN_USAGE } from "@revv/shared";
import { Effect } from "effect";
import { judgeArtifact } from "../../ai/jev/artifact-quality";
import { judgeIssue } from "../../ai/jev/issue-relevance";
import { applyJudgment } from "../../ai/jev/issue-relevance-persistence";
import { type JudgmentTracker, makeJudgmentTracker } from "../../ai/jev/pending";
import { judgeProse, makeProseMailbox } from "../../ai/jev/prose-voice";
import type { WalkthroughToolContext } from "../../ai/providers/walkthrough-tools";
import type { Db } from "../../db";
import { logError } from "../../logger";
import type { CacheService } from "../Cache";
import type { JevService } from "../Jev";
import type { SettingsService } from "../Settings";

export type JudgmentServices = JevService | SettingsService | CacheService;

export interface WalkthroughRunContext {
  readonly prId: string;
  /** The account that owns the PR's repository: where this run's events go. */
  readonly accountId: string;
  readonly mode: WalkthroughMode;
  readonly prHeadSha: string;
  readonly judgments: JudgmentTracker;
  /** What the `/mcp/walkthrough` handlers run against. */
  readonly tools: WalkthroughToolContext;
  /** The run's token usage so far, across auto-continuations. */
  tokenUsage: WalkthroughTokenUsage;
}

export function makeWalkthroughRunContext(input: {
  readonly db: Db;
  readonly walkthroughId: string;
  readonly prId: string;
  readonly accountId: string;
  readonly mode: WalkthroughMode;
  readonly prHeadSha: string;
  readonly emit: (event: WalkthroughStreamEvent) => void;
  readonly broadcastThreadEvent: (msg: ThreadEventMessage) => void;
  /** Runs a Jev judgment; never rejects for a judgment that degrades to "no opinion". */
  readonly runJudgment: <A>(effect: Effect.Effect<A, never, JudgmentServices>) => Promise<A>;
}): WalkthroughRunContext {
  const { db, walkthroughId, emit, broadcastThreadEvent, runJudgment } = input;
  const judgments = makeJudgmentTracker(walkthroughId);
  const prose = makeProseMailbox();

  const tools: WalkthroughToolContext = {
    db,
    walkthroughId,
    emit,
    broadcastThreadEvent,
    // Each hook collapses to "no opinion" on failure: a dependency defect
    // must never fail the tool call.
    jev: {
      scheduleIssueJudgment: (issueId, candidate) => {
        judgments.track(
          runJudgment(
            judgeIssue(db, walkthroughId, issueId, candidate).pipe(
              Effect.flatMap((judgment) =>
                judgment === null
                  ? Effect.void
                  : Effect.sync(() =>
                      applyJudgment(db, walkthroughId, issueId, candidate, judgment, {
                        emit,
                        broadcastThread: broadcastThreadEvent,
                        markRetracted: judgments.markRetracted,
                      }),
                    ),
              ),
            ),
          ),
        );
      },
      awaitIssueJudgments: () => judgments.drain(),
      issueRetracted: judgments.wasRetracted,
      judgeArtifact: (html, context) =>
        runJudgment(judgeArtifact(html, context)).catch((err: unknown) => {
          logError(
            "walkthrough-run",
            `artifact craft bar crashed for ${walkthroughId}:`,
            err instanceof Error ? err.message : String(err),
          );
          return { failed: [], reject: false };
        }),
      scheduleProseCheck: (markdown, chapterTitle) => {
        // Claimed synchronously so two blocks written back to back can't both
        // take the last slot.
        if (!prose.claimSample()) return;
        // Not tracked with the issue judgments: advice gates nothing, so the
        // completion gate's drain mustn't wait on it.
        runJudgment(
          judgeProse(markdown, chapterTitle).pipe(
            Effect.flatMap((advice) =>
              Effect.sync(() => {
                if (advice !== null) prose.post(advice);
              }),
            ),
          ),
        ).catch((err: unknown) => {
          logError(
            "walkthrough-run",
            `prose check crashed for ${walkthroughId}:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      },
      takeProseAdvice: prose.take,
    },
  };

  return {
    prId: input.prId,
    accountId: input.accountId,
    mode: input.mode,
    prHeadSha: input.prHeadSha,
    judgments,
    tools,
    tokenUsage: ZERO_TOKEN_USAGE,
  };
}
