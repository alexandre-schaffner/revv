// What a run does between launch and its verdict: check out the worktree at
// the head (alongside the first pass), build the prompt's file list, record
// the leads, then run agent turns until the journal says the review is
// finished or the auto-continuation budget is spent. Each turn reports only how
// it ended; what that means for the review is decided here, from the journal.

import type {
  RiskLevel,
  WalkthroughLead,
  WalkthroughLiveEvent,
  WalkthroughStackSnapshot,
} from "@revv/shared";
import { spanName } from "@revv/shared/telemetry";
import { count, eq } from "drizzle-orm";
import { type Context, Effect } from "effect";
import { adjudicateContinuation, classifyFailure } from "../../ai/jev/continuation";
import type { WalkthroughTurnEnd } from "../../ai/providers/walkthrough-acp";
import {
  accumulateTokenUsage,
  addThroughput,
  mergeContextOccupancy,
} from "../../ai/providers/walkthrough-token-usage";
import type { Db } from "../../db";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../db/schema/walkthrough-semantic-steps";
import {
  type DiffFingerprint,
  type WalkthroughLaunchPlan,
  walkthroughs,
} from "../../db/schema/walkthroughs";
import type { AiGenerationError, DbError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { debug } from "../../logger";
import type { AiService } from "../Ai";
import type { RepoCloneService } from "../clone/RepoClone";
import type { HunkScanService } from "../hunk-scan/HunkScan";
import { JevService } from "../Jev";
import type { AgentRun, RunEnd } from "../jobs/agent-jobs";
import { orchestratorCompletionBlocker } from "./completion";
import { findIssuesMissingInlineComment } from "./content";
import { leadsRecorded, prepareFirstPassLeads } from "./leads";
import { cloneFailure, type WalkthroughFailure } from "./lifecycle";
import { type PromptFile, resolveIncrementalPromptFiles } from "./prompt-files";
import type { WalkthroughRunContext } from "./run-context";

/** Auto-continuations a run may take after its first turn (invariant 9). */
export const MAX_AUTO_CONTINUATIONS = 2;

export interface WalkthroughRunInputs {
  readonly pr: {
    readonly id: string;
    readonly title: string;
    readonly body: string | null;
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly url: string;
    readonly externalId: number;
  };
  readonly repoId: string;
  readonly repoFullName: string;
  readonly githubHost: string;
  readonly token: string;
  readonly files: ReadonlyArray<PromptFile>;
  readonly generationMode: "full" | "incremental";
  readonly parentWalkthroughId: string | null;
  readonly baseHeadSha: string | null;
  /** The row already had content when this run started. */
  readonly resumed: boolean;
  readonly plan: WalkthroughLaunchPlan;
  readonly assignedRisk: RiskLevel | null;
  readonly stack: WalkthroughStackSnapshot | null;
  readonly parentFingerprint: DiffFingerprint | null;
}

export interface WalkthroughRunDeps {
  readonly db: Db;
  readonly ai: Context.Service.Shape<typeof AiService>;
  readonly repoClone: Context.Service.Shape<typeof RepoCloneService>;
  readonly hunkScan: Context.Service.Shape<typeof HunkScanService>;
  readonly jev: Context.Service.Shape<typeof JevService>;
  /** Live-only: broadcast unsequenced. */
  readonly publish: (event: WalkthroughLiveEvent) => void;
  /** The leads the agent is handed, announced before its first turn. */
  readonly announceLeads: (leads: WalkthroughLead[]) => Effect.Effect<void>;
}

interface Progress {
  readonly lastCompletedPhase: string;
  readonly hasSummary: boolean;
  readonly counts: Record<string, number>;
}

function readProgress(db: Db, walkthroughId: string): Progress {
  const row = db
    .select({ phase: walkthroughs.lastCompletedPhase, summary: walkthroughs.summary })
    .from(walkthroughs)
    .where(eq(walkthroughs.id, walkthroughId))
    .get();
  const countOf = (table: typeof walkthroughBlocks | typeof walkthroughIssues) =>
    db.select({ n: count() }).from(table).where(eq(table.walkthroughId, walkthroughId)).get()?.n ??
    0;
  return {
    lastCompletedPhase: row?.phase ?? "none",
    hasSummary: (row?.summary ?? "").length > 0,
    counts: {
      diff_steps: countOf(walkthroughBlocks),
      semantic_steps:
        db
          .select({ n: count() })
          .from(walkthroughSemanticSteps)
          .where(eq(walkthroughSemanticSteps.walkthroughId, walkthroughId))
          .get()?.n ?? 0,
      rated_axes:
        db
          .select({ n: count() })
          .from(walkthroughRatings)
          .where(eq(walkthroughRatings.walkthroughId, walkthroughId))
          .get()?.n ?? 0,
      issues: countOf(walkthroughIssues),
      issues_needing_inline_comment: findIssuesMissingInlineComment(db, walkthroughId).length,
    },
  };
}

/** Avoid "Internal error.. Nothing had been written" when joining clauses. */
const trimTrailingPeriod = (message: string): string => message.replace(/\.\s*$/, "");

/**
 * A turn ended and the journal isn't finished. A run that wrote nothing has no
 * partial for a continuation to build on; how its turn ended is the verdict.
 */
function failureWithoutContent(end: WalkthroughTurnEnd): WalkthroughFailure {
  switch (end.kind) {
    case "timeout":
      return {
        reason: "timeout_no_content",
        message: `${end.reason}, and nothing had been written yet. Try regenerating.`,
      };
    case "failed":
      return {
        reason: end.auth ? "agent_auth" : "agent_error",
        message: `${trimTrailingPeriod(end.message)}. Nothing had been written yet. Try regenerating.`,
      };
    case "cancelled":
      return { reason: "agent_error", message: end.reason };
    case "stopped":
      return {
        reason: "no_content",
        message:
          "The AI finished without producing a walkthrough. This can happen with complex PRs. Try regenerating.",
      };
  }
}

export function runWalkthrough(
  deps: WalkthroughRunDeps,
  run: AgentRun<WalkthroughRunContext>,
  inputs: WalkthroughRunInputs,
): Effect.Effect<RunEnd<WalkthroughFailure>, AiGenerationError | DbError> {
  // The review worktree lives for the run: its finalizer removes it on every
  // exit path (invariant 10).
  return Effect.scoped(
    Effect.gen(function* () {
      const { db } = deps;
      const ctx = run.context;

      // The first pass runs alongside the worktree checkout, which hides most of
      // its latency. Usually the review page already started it for this head,
      // and this joins that run (or reads its result) — for at most
      // HUNK_SCAN_JOIN_BUDGET_MS, so a large or slow scan never holds Phase A.
      // A resume is prompted with the leads its first run recorded, so it
      // doesn't wait on the scan at all.
      const resumedLeads = yield* dbTry("leadsRecorded", () => leadsRecorded(db, run.id)).pipe(
        Effect.orElseSucceed(() => false),
      );
      const hunkScan = resumedLeads
        ? Effect.succeed([])
        : deps.hunkScan.run({
            prId: inputs.pr.id,
            headSha: ctx.prHeadSha,
            files: inputs.files,
            filePriorities: inputs.plan.filePriorities,
          });
      const worktree = deps.repoClone
        .acquireReviewWorktree({
          repoId: inputs.repoId,
          prNumber: inputs.pr.externalId,
          headSha: ctx.prHeadSha,
          githubToken: inputs.token,
          walkthroughId: run.id,
        })
        .pipe(
          Effect.map((path) => ({ path })),
          Effect.catchTags({
            CloneError: (e) =>
              Effect.succeed({ failure: cloneFailure({ kind: "failed", error: e.message }) }),
            CloneNotReadyError: () =>
              Effect.succeed({ failure: cloneFailure({ kind: "missing" }) }),
          }),
        );
      const [checkout, hunkScanRows] = yield* Effect.all([worktree, hunkScan], {
        concurrency: 2,
      });
      if ("failure" in checkout) return { kind: "failed", failure: checkout.failure };
      const worktreePath = checkout.path;

      const promptInput = yield* resolveIncrementalPromptFiles(
        {
          pr: inputs.pr,
          token: inputs.token,
          prHeadSha: ctx.prHeadSha,
          repoFullName: inputs.repoFullName,
          githubHost: inputs.githubHost,
          files: inputs.files,
          generationMode: inputs.generationMode,
          baseHeadSha: inputs.baseHeadSha,
          stack: inputs.stack,
          parentFingerprint: inputs.parentFingerprint,
        },
        worktreePath,
      ).pipe(
        Effect.tap((result) =>
          Effect.annotateCurrentSpan({
            diff_source: result.diffSource,
            files: result.files.length,
          }),
        ),
        Effect.withSpan(spanName("walkthrough", "resolveDiff")),
      );
      const hunkLeads = yield* prepareFirstPassLeads(db, run.id, hunkScanRows, promptInput);
      yield* deps.announceLeads(hunkLeads);

      const onLive = (event: WalkthroughLiveEvent): void => {
        if (event.type !== "usage") {
          deps.publish(event);
          return;
        }
        // Occupancy is a point-in-time gauge; throughput is only previewed
        // until the turn's total lands.
        ctx.tokenUsage = mergeContextOccupancy(ctx.tokenUsage, event.data.tokenUsage);
        deps.publish({
          type: "usage",
          data: { tokenUsage: addThroughput(ctx.tokenUsage, event.data.tokenUsage) },
        });
      };
      const turn = (resumed: boolean) =>
        deps.ai.walkthroughTurn({
          walkthroughId: run.id,
          pr: inputs.pr,
          files: promptInput.files,
          mode: ctx.mode,
          worktreePath,
          reviewMode: {
            mode: inputs.generationMode,
            parentWalkthroughId: inputs.parentWalkthroughId,
            baseHeadSha: inputs.baseHeadSha,
            headSha: ctx.prHeadSha,
            diffSource: promptInput.diffSource,
          },
          resumed,
          ...(inputs.assignedRisk ? { assignedRisk: inputs.assignedRisk } : {}),
          ...(inputs.plan.filePriorities ? { filePriorities: inputs.plan.filePriorities } : {}),
          ...(inputs.plan.splitRecommendation
            ? { splitRecommendation: inputs.plan.splitRecommendation }
            : {}),
          ...(hunkLeads.length > 0 ? { hunkLeads } : {}),
          ...(inputs.stack ? { stack: inputs.stack } : {}),
          mcpToken: run.token,
          activity: run.activity,
          abortController: run.abort,
          launch: {
            agent: inputs.plan.agent,
            model: inputs.plan.model,
            thinkingEffort: inputs.plan.thinkingEffort ?? undefined,
          },
          onLive,
        });

      const startedAt = Date.now();
      let continuations = 0;
      let previous: Progress | null = null;
      let resumed = inputs.resumed;

      while (true) {
        const result = yield* turn(resumed).pipe(
          Effect.catchTag("AiNotConfiguredError", () => Effect.succeed(null)),
        );
        if (result === null) {
          return {
            kind: "failed",
            failure: {
              reason: "agent_error",
              message:
                "The selected AI agent can't be launched — install it or pick another in Settings",
            },
          };
        }
        const { end, tokenUsage } = result;
        ctx.tokenUsage = accumulateTokenUsage(ctx.tokenUsage, tokenUsage);
        deps.publish({ type: "usage", data: { tokenUsage: ctx.tokenUsage } });
        // A Stop or a supersede: the kernel settles it.
        if (run.stopReason() !== null) {
          return { kind: "failed", failure: failureWithoutContent(end) };
        }

        // The orchestrator decides on a stable issue set.
        yield* Effect.promise(() => ctx.judgments.drain());
        const blocker = yield* dbTry("completion check", () =>
          orchestratorCompletionBlocker(db, run.id),
        );
        if (blocker === null) return { kind: "complete" };

        if (end.kind === "stopped" && end.refused) {
          return {
            kind: "failed",
            failure: { reason: "agent_error", message: "The agent declined to continue." },
          };
        }
        // Another turn would fail the same way until the user signs the agent in.
        if (end.kind === "failed" && end.auth) {
          return { kind: "failed", failure: { reason: "agent_auth", message: end.message } };
        }
        const progress = yield* dbTry("read progress", () => readProgress(db, run.id));
        if (end.kind === "cancelled" || !progress.hasSummary) {
          return { kind: "failed", failure: failureWithoutContent(end) };
        }

        const adjudication = {
          autoContinuations: continuations,
          maxAutoContinuations: MAX_AUTO_CONTINUATIONS,
          lastCompletedPhase: progress.lastCompletedPhase,
          phaseAtLastContinuation: previous?.lastCompletedPhase ?? null,
          counts: progress.counts,
          countsAtLastContinuation: previous?.counts ?? null,
          terminalReason: end.kind,
          elapsedMs: Date.now() - startedAt,
          totalTokens: ctx.tokenUsage.inputTokens + ctx.tokenUsage.outputTokens,
        };
        let stoppedEarlyBecause: string | null = null;
        if (continuations >= MAX_AUTO_CONTINUATIONS) {
          debug("walkthrough-run", `${run.id}: auto-continuations spent`);
        } else if (continuations >= 1) {
          // Not on the first: "progress since the last continuation" is
          // undefined, and the first continuation most often succeeds anyway.
          const verdict = yield* adjudicateContinuation(adjudication).pipe(
            Effect.provideService(JevService, deps.jev),
          );
          if (verdict.kind === "stop-doomed") stoppedEarlyBecause = verdict.reason;
        }
        if (continuations >= MAX_AUTO_CONTINUATIONS || stoppedEarlyBecause !== null) {
          const base =
            progress.lastCompletedPhase === "D"
              ? (progress.counts.issues_needing_inline_comment ?? 0) > 0
                ? "Generation finished but line-anchored concerns lack inline comments."
                : "Generation finished but the walkthrough is incomplete."
              : stoppedEarlyBecause !== null
                ? `Generation stopped early: ${stoppedEarlyBecause}.`
                : "Generation exhausted auto-continuation budget before reaching phase D.";
          const hint = yield* classifyFailure(adjudication).pipe(
            Effect.provideService(JevService, deps.jev),
          );
          return {
            kind: "failed",
            failure: {
              reason: "budget_exhausted",
              message: hint === null ? base : `${base} ${hint}`,
            },
          };
        }

        continuations += 1;
        previous = progress;
        resumed = true;
        debug(
          "walkthrough-run",
          `${run.id}: auto-continuation ${continuations}/${MAX_AUTO_CONTINUATIONS} at phase ${progress.lastCompletedPhase}`,
        );
        deps.publish({
          type: "phase",
          data: {
            phase: "rating",
            message: `Finishing walkthrough (phase ${progress.lastCompletedPhase})...`,
          },
        });
      }
    }),
  );
}
