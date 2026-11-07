import { randomUUID } from "node:crypto";
import { isOpenLayer, type StackBriefStatus } from "@revv/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { runStackBriefAgentViaAcp } from "../../ai/providers/stack-brief-acp";
import {
  type StackBriefToolContext,
  stackBriefCompletionBlocker,
} from "../../ai/providers/stack-brief-tools";
import { pullRequests } from "../../db/schema/pull-requests";
import { type StackBriefSnapshot, stackBriefs } from "../../db/schema/stack-briefs";
import type { DbError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { withDb } from "../../effects/with-db";
import { withTraceAnchor } from "../../observability/span-graft";
import { DbService } from "../Db";
import { makeStartJobMutex } from "../job-mutex";
import {
  type AgentJobs,
  type AgentRun,
  makeAgentJobs,
  type RunEnd,
  type RunOutcome,
} from "../jobs/agent-jobs";
import {
  newToolGate,
  runToolGatedTurn,
  TOOL_GATED_FAILURES,
  type ToolGate,
  toolGateHooks,
} from "../jobs/tool-gated-run";
import { PrContextService } from "../PrContext";
import { Realtime } from "../Realtime";
import { SettingsService } from "../Settings";
import { stackSignature } from "./fingerprint";
import type { GitHubStack } from "./map";
import { type StackError, StackService } from "./StackService";

const MAX_CONCURRENT_BRIEF_JOBS = 1;

const BODY_EXCERPT_CHARS = 1200;

export class StackBriefJobs extends Context.Service<
  StackBriefJobs,
  {
    /**
     * The brief for the PR's stack as GitHub has it now: the id of the one
     * written or generating for this version, or of a new one started (which
     * supersedes the stack's older briefs). An errored brief for this version
     * is retried. Null when the PR isn't stacked or nothing in it is open.
     */
    readonly ensure: (
      prId: string,
      userId: string,
      accountId?: string,
    ) => Effect.Effect<string | null, StackError>;
    readonly resumePending: () => Effect.Effect<void>;
    readonly resolveSessionToken: (token: string) => Effect.Effect<StackBriefToolContext | null>;
  }
>()("StackBriefJobs") {}

export function buildStackBriefSnapshot(
  stack: GitHubStack,
  tracked: ReadonlyMap<number, { readonly id: string; readonly body: string | null }>,
): StackBriefSnapshot {
  return {
    stackNumber: stack.number,
    baseRefName: stack.baseRefName,
    layers: stack.layers.filter(isOpenLayer).map((l) => {
      const pr = tracked.get(l.number);
      const body = pr?.body?.trim() ?? "";
      return {
        position: l.position,
        number: l.number,
        title: l.title,
        headSha: l.headSha,
        status: l.status,
        prId: pr?.id ?? null,
        additions: l.additions,
        deletions: l.deletions,
        changedFiles: l.changedFiles,
        body:
          body.length === 0
            ? null
            : body.length > BODY_EXCERPT_CHARS
              ? `${body.slice(0, BODY_EXCERPT_CHARS)}…`
              : body,
      };
    }),
    merged: stack.layers
      .filter((l) => l.status === "merged")
      .map((l) => ({ number: l.number, title: l.title })),
    capturedAt: stack.fetchedAt,
  };
}

interface BriefRun extends ToolGate {
  readonly tools: StackBriefToolContext;
}

export const StackBriefJobsLive = Layer.effect(
  StackBriefJobs,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const realtime = yield* Realtime;
    const prCtx = yield* PrContextService;
    const settingsService = yield* SettingsService;
    const stacks = yield* StackService;

    const stackMutex = yield* makeStartJobMutex();

    const announce = (
      repositoryId: string,
      stackNumber: number,
      briefId: string,
      status: StackBriefStatus,
    ): Effect.Effect<void> =>
      realtime.toRepo(repositoryId, {
        type: "stack-brief:status-changed",
        data: { repositoryId, stackNumber, briefId, status },
      });

    const settle = (
      briefId: string,
      outcome: RunOutcome<string>,
      run: AgentRun<BriefRun> | null,
    ): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const status = outcome.kind === "complete" ? "complete" : "error";
        const modelUsed = run?.context.modelUsed ?? null;
        const [moved] = yield* dbTry("stack brief status update", () =>
          db
            .update(stackBriefs)
            .set({
              status,
              ...(status === "complete" ? { completedAt: new Date().toISOString() } : {}),
              ...(modelUsed ? { modelUsed } : {}),
              errorMessage:
                outcome.kind === "failed"
                  ? outcome.failure
                  : outcome.kind === "stopped"
                    ? "Stopped"
                    : null,
            })
            .where(and(eq(stackBriefs.id, briefId), eq(stackBriefs.status, "generating")))
            .returning({
              repositoryId: stackBriefs.repositoryId,
              stackNumber: stackBriefs.stackNumber,
            })
            .all(),
        );
        if (moved) yield* announce(moved.repositoryId, moved.stackNumber, briefId, status);
      });

    const jobs: AgentJobs<BriefRun, string> = yield* makeAgentJobs<BriefRun, string>({
      name: "stack-brief",
      concurrency: MAX_CONCURRENT_BRIEF_JOBS,
      turnsPerRun: 1,
      journal: {
        generating: dbTry("stack brief resume scan", () =>
          db
            .select({ id: stackBriefs.id })
            .from(stackBriefs)
            .where(eq(stackBriefs.status, "generating"))
            .all()
            .map((row) => row.id),
        ),
        bumpResumeAttempts: (briefId) =>
          dbTry("stack brief resume count", () => {
            const [row] = db
              .update(stackBriefs)
              .set({ resumeAttempts: sql`${stackBriefs.resumeAttempts} + 1` })
              .where(eq(stackBriefs.id, briefId))
              .returning({ attempts: stackBriefs.resumeAttempts })
              .all();
            if (!row) throw new Error(`stack brief ${briefId} not found`);
            return row.attempts;
          }),
        completionBlocker: (briefId) =>
          dbTry("stack brief completion check", () => stackBriefCompletionBlocker(db, briefId)),
      },
      settle,
      ...TOOL_GATED_FAILURES,
      relaunch: (briefId) => launch(briefId),
    });

    const runBrief = (run: AgentRun<BriefRun>): Effect.Effect<RunEnd<string>, DbError> =>
      Effect.gen(function* () {
        const row = yield* dbTry("stack brief read", () =>
          db.select().from(stackBriefs).where(eq(stackBriefs.id, run.id)).get(),
        );
        if (!row) return { kind: "failed", failure: "The stack brief row is gone" };
        const snapshot = row.stackSnapshot;
        if (snapshot.layers.length === 0) {
          return { kind: "failed", failure: "The stack snapshot has no layers" };
        }

        const repo = yield* withDb(db, prCtx.getRepo(row.repositoryId)).pipe(
          Effect.orElseSucceed(() => null),
        );
        return yield* runToolGatedTurn({
          run,
          purpose: "brief",
          clonePath: repo?.clonePath ?? null,
          turn: (agent) =>
            runStackBriefAgentViaAcp({
              ctx: run.context.tools,
              snapshot,
              sessionToken: run.token,
              abortController: run.abort,
              activity: run.activity,
              ...agent,
            }),
          unfinished: "The agent stopped before complete_stack_brief; the brief is unfinished",
        }).pipe(Effect.provideService(SettingsService, settingsService));
      });

    const launch = (briefId: string): Effect.Effect<void> =>
      jobs
        .launch({
          id: briefId,
          context: (handles): BriefRun => {
            const gate = newToolGate();
            return Object.assign(gate, {
              tools: { db, briefId, ...toolGateHooks(gate, handles.abort) },
            });
          },
          body: runBrief,
          instrument: (_run, effect) =>
            effect.pipe(
              withTraceAnchor(briefId),
              Effect.withSpan("StackBriefJobs.job", { attributes: { briefId } }),
            ),
        })
        .pipe(Effect.asVoid);

    const ensure = (prId: string, userId: string, accountId?: string) =>
      Effect.gen(function* () {
        const ctx = yield* withDb(db, prCtx.forPr(prId, accountId));
        const stack = yield* stacks.fetchFresh(ctx);
        if (!stack) return null;
        const open = stack.layers.filter(isOpenLayer);
        if (open.length === 0) return null;
        const repositoryId = ctx.repo.id;
        const signature = stackSignature(stack.layers);

        const mutex = yield* stackMutex.acquire(`${repositoryId}:${stack.number}`);
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const active = yield* dbTry("stack brief lookup", () =>
              db
                .select({
                  id: stackBriefs.id,
                  signature: stackBriefs.signature,
                  status: stackBriefs.status,
                })
                .from(stackBriefs)
                .where(
                  and(
                    eq(stackBriefs.repositoryId, repositoryId),
                    eq(stackBriefs.stackNumber, stack.number),
                    ne(stackBriefs.status, "superseded"),
                  ),
                )
                .all(),
            );
            const current = active.find((b) => b.signature === signature && b.status !== "error");
            if (current) {
              if (current.status === "generating") yield* jobs.resume(current.id);
              return current.id;
            }

            const tracked = yield* dbTry("stack layer read", () =>
              db
                .select({
                  id: pullRequests.id,
                  number: pullRequests.externalId,
                  body: pullRequests.body,
                })
                .from(pullRequests)
                .where(
                  and(
                    eq(pullRequests.repositoryId, repositoryId),
                    inArray(
                      pullRequests.externalId,
                      open.map((l) => l.number),
                    ),
                  ),
                )
                .all(),
            );
            const snapshot = buildStackBriefSnapshot(
              stack,
              new Map(tracked.map((t) => [t.number, t])),
            );

            const briefId = randomUUID();
            const retired = active.map((b) => b.id);
            yield* dbTry("stack brief create", () =>
              db.transaction(() => {
                if (retired.length > 0) {
                  db.update(stackBriefs)
                    .set({ status: "superseded", supersededBy: briefId })
                    .where(inArray(stackBriefs.id, retired))
                    .run();
                }
                db.insert(stackBriefs)
                  .values({
                    id: briefId,
                    repositoryId,
                    stackNumber: stack.number,
                    signature,
                    stackSnapshot: snapshot,
                    status: "generating",
                    userId,
                    createdAt: new Date().toISOString(),
                  })
                  .run();
              }),
            );

            for (const id of retired) {
              yield* jobs.stop(id, "superseded");
              yield* announce(repositoryId, stack.number, id, "superseded");
            }
            yield* announce(repositoryId, stack.number, briefId, "generating");
            yield* launch(briefId);
            return briefId;
          }),
        );
      });

    return {
      ensure,
      resumePending: () => jobs.resumePending,
      resolveSessionToken: (token) =>
        Effect.map(jobs.resolveToken(token), (run) => run?.context.tools ?? null),
    };
  }),
);
