// ── StackBriefJobs ──────────────────────────────────────────────────────────
// Durable orchestrator for stack briefs, the agent-written arc of a GitHub PR
// stack. Shaped like ProjectRecapJobs, smaller still: one brief per stack
// version (`signature`), no worktree, no live stream, one job at a time.
//
// The row is the journal (CLAUDE.md invariant 1): the stack the agent briefs
// is snapshotted onto it at creation, so a resume needs neither GitHub nor
// memory. Content arrives only through the `/mcp/stack-brief` tool handlers
// (invariant 2); this service is the only writer of `status`, and it
// broadcasts `stack-brief:status-changed` after each transition commits
// (invariants 8 and 11).

import { randomUUID } from "node:crypto";
import type { StackBriefStatus } from "@revv/shared";
import { resolveThinkingEffort } from "@revv/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import { Cause, Context, Effect, Fiber, Layer, Ref } from "effect";
import { isAcpAgentAvailable, resolveGenerationModel } from "../../ai/acp/presets";
import { runStackBriefAgentViaAcp } from "../../ai/providers/stack-brief-acp";
import {
  completeStackBriefHandler,
  parseStackBriefSnapshot,
  type StackBriefSnapshot,
  type StackBriefToolContext,
} from "../../ai/providers/stack-brief-tools";
import { CLI_WALKTHROUGH_TIMEOUT_MS } from "../../constants";
import { pullRequests } from "../../db/schema/pull-requests";
import { stackBriefs } from "../../db/schema/stack-briefs";
import { DbError } from "../../domain/errors";
import { withDb } from "../../effects/with-db";
import { debug, logError } from "../../logger";
import { Broadcaster } from "../Broadcaster";
import { CacheService } from "../Cache";
import { DbService } from "../Db";
import { analyzeJobFailure } from "../job-failure";
import { makeStartJobMutex } from "../job-mutex";
import { PrContextService } from "../PrContext";
import { SettingsService } from "../Settings";
import { makeSessionTokenStore } from "../session-token-store";
import { stackSignature } from "./fingerprint";
import type { GitHubStack } from "./map";
import { type StackError, StackService } from "./StackService";

/** One brief at a time: it's a background nicety, never worth a walkthrough's slot. */
const MAX_CONCURRENT_BRIEF_JOBS = 1;

/** Boot resumes before the row goes to 'error'. */
export const STACK_BRIEF_MAX_RESUME_ATTEMPTS = 3;

const SESSION_TOKEN_TTL_MS = CLI_WALKTHROUGH_TIMEOUT_MS + 5 * 60_000;

/** A layer's description, as much as the agent needs to tell what it's for. */
const BODY_EXCERPT_CHARS = 1200;

interface ActiveBriefJob {
  readonly briefId: string;
  readonly abortController: AbortController;
  fiber: Fiber.RuntimeFiber<void, never> | null;
  /** Set when a newer brief superseded this one: the run's end is nobody's error. */
  superseded: boolean;
  validated: boolean;
}

export class StackBriefJobs extends Context.Tag("StackBriefJobs")<
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
    /** Re-launch rows a prior process left 'generating'. */
    readonly resumePending: () => Effect.Effect<void>;
    /** The tool context a `/mcp/stack-brief` bearer token was issued for. */
    readonly resolveSessionToken: (token: string) => Effect.Effect<StackBriefToolContext | null>;
  }
>() {}

const isOpen = (layer: { readonly status: string }) =>
  layer.status !== "merged" && layer.status !== "closed";

/** The stack the agent will brief, frozen onto the row. */
export function buildStackBriefSnapshot(
  stack: GitHubStack,
  tracked: ReadonlyMap<number, { readonly id: string; readonly body: string | null }>,
): StackBriefSnapshot {
  return {
    stackNumber: stack.number,
    baseRefName: stack.baseRefName,
    layers: stack.layers.filter(isOpen).map((l) => {
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

export const StackBriefJobsLive = Layer.effect(
  StackBriefJobs,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const cache = yield* CacheService;
    const broadcaster = yield* Broadcaster;
    const prCtx = yield* PrContextService;
    const settingsService = yield* SettingsService;
    const stacks = yield* StackService;

    const registry = yield* Ref.make(new Map<string, ActiveBriefJob>());
    const semaphore = yield* Effect.makeSemaphore(MAX_CONCURRENT_BRIEF_JOBS);
    const stackMutex = yield* makeStartJobMutex();
    const sessions = yield* makeSessionTokenStore<StackBriefToolContext>(SESSION_TOKEN_TTL_MS);

    const dbTry = <A>(message: string, run: () => A): Effect.Effect<A, DbError> =>
      Effect.try({ try: run, catch: (cause) => new DbError({ message, cause }) });

    const announce = (
      repositoryId: string,
      stackNumber: number,
      briefId: string,
      status: StackBriefStatus,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const accountId = yield* withDb(db, prCtx.getAccountIdForRepo(repositoryId));
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "stack-brief:status-changed",
          data: { repositoryId, stackNumber, briefId, status },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchAll(() => Effect.void),
      );

    /**
     * The one lifecycle chokepoint after creation. Only a 'generating' row
     * moves: a brief superseded mid-run stays superseded whatever its run
     * ends with.
     */
    const finish = (
      briefId: string,
      status: "complete" | "error",
      options: { readonly modelUsed?: string; readonly errorMessage?: string } = {},
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const [moved] = yield* dbTry("stack brief status update failed", () =>
          db
            .update(stackBriefs)
            .set({
              status,
              ...(status === "complete" ? { completedAt: new Date().toISOString() } : {}),
              ...(options.modelUsed ? { modelUsed: options.modelUsed } : {}),
              errorMessage: options.errorMessage ?? null,
            })
            .where(and(eq(stackBriefs.id, briefId), eq(stackBriefs.status, "generating")))
            .returning({
              repositoryId: stackBriefs.repositoryId,
              stackNumber: stackBriefs.stackNumber,
            })
            .all(),
        );
        if (moved) yield* announce(moved.repositoryId, moved.stackNumber, briefId, status);
      }).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => logError("stack-brief", `status → ${status} failed for ${briefId}`, e)),
        ),
      );

    const removeJob = (job: ActiveBriefJob) =>
      Ref.update(registry, (map) => {
        if (map.get(job.briefId) !== job) return map;
        const next = new Map(map);
        next.delete(job.briefId);
        return next;
      });

    // ── Job body ─────────────────────────────────────────────────────────

    const runJob = (job: ActiveBriefJob): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const row = yield* dbTry("stack brief read failed", () =>
          db.select().from(stackBriefs).where(eq(stackBriefs.id, job.briefId)).get(),
        );
        if (row?.status !== "generating") return;
        const snapshot = parseStackBriefSnapshot(row.stackSnapshot);
        if (!snapshot || snapshot.layers.length === 0) {
          yield* finish(job.briefId, "error", { errorMessage: "The stack snapshot is unreadable" });
          return;
        }

        // The user's walkthrough agent and model: the brief is written by the
        // same hand as the layers' walkthroughs it summarises.
        const settings = yield* settingsService
          .getSettings()
          .pipe(Effect.orElseSucceed(() => null));
        const agent = yield* settingsService.resolveAgent().pipe(Effect.orElseSucceed(() => null));
        if (!agent || !isAcpAgentAvailable(agent)) {
          yield* finish(job.briefId, "error", {
            errorMessage: `The configured agent ('${agent ?? "unknown"}') is not available on this machine.`,
          });
          return;
        }
        const modelUsed =
          resolveGenerationModel(agent, settings?.aiModel) ??
          (agent === "opencode" ? "opencode" : "claude-sonnet-4-20250514");
        const repo = yield* withDb(db, prCtx.getRepo(row.repositoryId)).pipe(
          Effect.orElseSucceed(() => null),
        );

        const ctx: StackBriefToolContext = {
          db,
          briefId: job.briefId,
          toolCalls: new Set<string>(),
          onCompleted: () => {
            job.validated = true;
            if (!job.abortController.signal.aborted) {
              job.abortController.abort(new Error("Stack brief completed"));
            }
          },
        };

        const outcome = yield* Effect.acquireUseRelease(
          sessions.issue(ctx),
          (sessionToken) =>
            Effect.promise(() =>
              runStackBriefAgentViaAcp({
                ctx,
                snapshot,
                sessionToken,
                acpAgentId: agent,
                modelUsed,
                thinkingEffort: resolveThinkingEffort(settings?.aiThinkingEffort),
                workingDir: repo?.clonePath ?? process.cwd(),
                abortController: job.abortController,
                isValidated: () => job.validated,
              }),
            ),
          (sessionToken) => sessions.clear(sessionToken),
        );

        if (job.superseded) return;
        if (outcome.validatedComplete) {
          yield* finish(job.briefId, "complete", { modelUsed });
          return;
        }

        // The agent may have written everything and stopped short of the
        // gate. The gate only reads the DB, so run it on the agent's behalf.
        if (ctx.toolCalls?.has("get_stack_brief_state")) {
          const gate = yield* Effect.promise(() => completeStackBriefHandler(ctx, {}));
          if (!gate.isError) {
            debug("stack-brief", `${job.briefId}: completed after a missed complete_stack_brief`);
            yield* finish(job.briefId, "complete", { modelUsed });
            return;
          }
        }
        yield* finish(job.briefId, "error", {
          modelUsed,
          errorMessage:
            outcome.error ??
            "The agent stopped before complete_stack_brief; the brief is unfinished",
        });
      });

    const launch = (briefId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(registry)).get(briefId);
        if (existing && !existing.abortController.signal.aborted) return;

        const job: ActiveBriefJob = {
          briefId,
          abortController: new AbortController(),
          fiber: null,
          superseded: false,
          validated: false,
        };
        yield* Ref.update(registry, (map) => new Map(map).set(briefId, job));

        const body = runJob(job).pipe(
          semaphore.withPermits(1),
          Effect.catchAllCause((cause) => {
            // A shutdown interrupt leaves the row for resume-on-boot.
            if (
              analyzeJobFailure(cause, { cancelledByUser: job.superseded }) === "leave-for-resume"
            ) {
              return Effect.void;
            }
            if (job.superseded) return Effect.void;
            logError("stack-brief", `job ${briefId} failed:`, Cause.pretty(cause));
            return finish(briefId, "error", {
              errorMessage: `Generation failed unexpectedly: ${Cause.pretty(cause).slice(0, 200)}`,
            });
          }),
          Effect.ensuring(removeJob(job)),
          Effect.withSpan("StackBriefJobs.job", { attributes: { briefId } }),
        );
        job.fiber = yield* Effect.forkDaemon(body);
      });

    /** Stop a superseded brief's run, if it has one. */
    const stopRun = (briefId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const job = (yield* Ref.get(registry)).get(briefId);
        if (!job) return;
        job.superseded = true;
        if (!job.abortController.signal.aborted) {
          job.abortController.abort(new Error("Stack brief superseded"));
        }
        if (job.fiber) yield* Fiber.interruptFork(job.fiber);
        yield* sessions.clearWhere((c) => c.briefId === briefId);
      });

    // ── Public API ───────────────────────────────────────────────────────

    const ensure = (prId: string, userId: string, accountId?: string) =>
      Effect.gen(function* () {
        const ctx = yield* withDb(db, prCtx.resolveBasic(prId, userId, accountId));
        const stack = yield* stacks
          .fetchFresh(ctx)
          .pipe(
            Effect.provideService(DbService, { db }),
            Effect.provideService(CacheService, cache),
          );
        if (!stack) return null;
        const open = stack.layers.filter(isOpen);
        if (open.length === 0) return null;
        const repositoryId = ctx.repo.id;
        const signature = stackSignature(stack.layers);

        const mutex = yield* stackMutex.acquire(`${repositoryId}:${stack.number}`);
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const active = yield* dbTry("stack brief lookup failed", () =>
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
              // A generating row with no live run (its process died before
              // boot resumed it) picks up where its tools left off.
              if (current.status === "generating") yield* launch(current.id);
              return current.id;
            }

            const tracked = yield* dbTry("stack layer read failed", () =>
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
            yield* dbTry("stack brief create failed", () =>
              db.transaction(() => {
                // Retire first: the active-signature unique index admits one
                // non-superseded row per version.
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
                    stackSnapshot: JSON.stringify(snapshot),
                    status: "generating",
                    userId,
                    createdAt: new Date().toISOString(),
                  })
                  .run();
              }),
            );

            for (const id of retired) {
              yield* stopRun(id);
              yield* announce(repositoryId, stack.number, id, "superseded");
            }
            yield* announce(repositoryId, stack.number, briefId, "generating");
            yield* launch(briefId);
            return briefId;
          }),
        );
      });

    const resumePending = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const rows = yield* dbTry("stack brief resume scan failed", () =>
          db
            .select({ id: stackBriefs.id, attempts: stackBriefs.resumeAttempts })
            .from(stackBriefs)
            .where(eq(stackBriefs.status, "generating"))
            .all(),
        );
        debug("stack-brief", `resumePending: ${rows.length} row(s)`);
        for (const row of rows) {
          const attempts = row.attempts + 1;
          yield* dbTry("stack brief resume count failed", () =>
            db
              .update(stackBriefs)
              .set({ resumeAttempts: attempts })
              .where(eq(stackBriefs.id, row.id))
              .run(),
          );
          if (attempts > STACK_BRIEF_MAX_RESUME_ATTEMPTS) {
            yield* finish(row.id, "error", {
              errorMessage: `Exceeded max resume attempts (${STACK_BRIEF_MAX_RESUME_ATTEMPTS}) after repeated crashes`,
            });
            continue;
          }
          yield* launch(row.id);
        }
      }).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => logError("stack-brief", "resumePending failed", e)),
        ),
        Effect.withSpan("StackBriefJobs.resumePending"),
      );

    return { ensure, resumePending, resolveSessionToken: sessions.resolve };
  }),
);
