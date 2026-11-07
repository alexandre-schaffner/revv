// One chat turn, from a user message to a journaled stream of frames. It holds
// the PR's workspace for the whole turn (a push or a commit edit is refused
// meanwhile, and vice versa), brings the worktree to the PR head, keys the
// session on the chat launch at that head, applies the plan gate, records the
// user message before the agent starts, and journals every frame the agent
// emits before the client sees it.

import type {
  ChatAttachment,
  ChatAttachmentMetadata,
  ChatStreamFrame,
  InteractionMode,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { ChatHistoryEntry, ChatWalkthroughContext } from "../../ai/prompts/chat";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import {
  type AiError,
  type CloneError,
  type CloneNotReadyError,
  type DbError,
  type GitHubError,
  type GitOperationError,
  PlanGateError,
  type WorkspaceBusyError,
  type WorktreeBlockedByUnpushedCommits,
} from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { logError } from "../../logger";
import { AiService } from "../Ai";
import { DbService } from "../Db";
import { type PrContextError, PrContextService } from "../PrContext";
import { latestCompleteWalkthrough } from "../walkthrough/content";
import { PrWorkspace } from "../workspace/PrWorkspace";
import { ChatSessionService } from "./ChatSession";
import { journalTurn } from "./turn-journal";

export interface ChatTurnParams {
  readonly prId: string;
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly attachmentMetadata: ReadonlyArray<ChatAttachmentMetadata>;
  readonly interactionMode?: InteractionMode;
  /** The pending plan this message approves; the turn leaves plan mode. */
  readonly approvedPlanId?: string;
}

export type ChatTurnError =
  | PlanGateError
  | WorkspaceBusyError
  | WorktreeBlockedByUnpushedCommits
  | PrContextError
  | GitHubError
  | CloneError
  | CloneNotReadyError
  | GitOperationError
  | AiError
  | DbError;

export class ChatTurnService extends Context.Service<
  ChatTurnService,
  {
    /**
     * Start a turn. Refusals fail before the agent runs; once the stream is
     * returned, the turn ends when it does, journaled.
     */
    readonly start: (
      params: ChatTurnParams,
    ) => Effect.Effect<ReadableStream<ChatStreamFrame>, ChatTurnError>;
  }
>()("ChatTurnService") {}

const MAX_PROMPT_ISSUES = 40;

export const ChatTurnServiceLive = Layer.effect(
  ChatTurnService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const prCtx = yield* PrContextService;
    const workspace = yield* PrWorkspace;
    const chatSessions = yield* ChatSessionService;
    const ai = yield* AiService;

    const walkthroughContext = (prId: string) =>
      dbTry("chat walkthrough context", (): ChatWalkthroughContext | null => {
        const row = latestCompleteWalkthrough(db, prId);
        if (!row) return null;
        const issues = db
          .select()
          .from(walkthroughIssues)
          .where(eq(walkthroughIssues.walkthroughId, row.id))
          .orderBy(walkthroughIssues.order)
          .limit(MAX_PROMPT_ISSUES)
          .all();
        return {
          summary: row.summary ?? "",
          riskLevel: row.riskLevel ?? "low",
          sentiment: row.sentiment ?? null,
          issues: issues.map((i) => ({
            severity: i.severity,
            title: i.title,
            description: i.description,
            filePath: i.filePath,
            startLine: i.startLine,
            endLine: i.endLine,
          })),
        };
      }).pipe(
        // The prompt reads fine without it.
        Effect.catch((err) =>
          Effect.sync(() => {
            logError("chat", "walkthrough context unavailable:", err.message);
            return null;
          }),
        ),
      );

    const prepare = (params: ChatTurnParams, scope: Scope.Closeable) =>
      Effect.gen(function* () {
        const ctx = yield* prCtx.forPr(params.prId);
        const { pr } = ctx;
        const { claim, branch, headSha } = yield* workspace
          .open(ctx, "chat-turn")
          .pipe(Scope.provide(scope));
        const { session, launch } = yield* workspace.openSession(ctx, headSha, branch);

        const pendingPlan = yield* chatSessions.findPendingPlan(session.id);
        if (pendingPlan && pendingPlan.id !== params.approvedPlanId) {
          return yield* Effect.fail(
            new PlanGateError({ reason: "pending", planId: pendingPlan.id }),
          );
        }
        if (params.approvedPlanId) {
          const decided = yield* chatSessions.decidePlan({
            prId: pr.id,
            planId: params.approvedPlanId,
            decision: "approved",
          });
          if (!decided) {
            return yield* Effect.fail(
              new PlanGateError({ reason: "not-found", planId: params.approvedPlanId }),
            );
          }
        }
        const mode: InteractionMode = params.approvedPlanId
          ? "default"
          : (params.interactionMode ?? session.interactionMode);
        if (mode !== session.interactionMode) {
          yield* chatSessions.setInteractionMode({ chatSessionId: session.id, mode });
        }

        // Plans and task lists have their own surfaces; the prompt's history
        // carries the conversation. Read before this turn's message is added.
        const history = (yield* chatSessions.listTimeline(session.id)).flatMap(
          (e): ChatHistoryEntry[] =>
            e.entryKind === "message"
              ? [{ entryKind: "message", role: e.role, content: e.content }]
              : e.entryKind === "activity"
                ? [
                    {
                      entryKind: "activity",
                      activityKind: e.activityKind,
                      toolName: e.toolName,
                      summary: e.summary,
                    },
                  ]
                : [],
        );
        const turnId = crypto.randomUUID();
        yield* chatSessions.appendUserMessage({
          chatSessionId: session.id,
          turnId,
          content: params.message,
          attachments: params.attachmentMetadata,
        });

        const abort = new AbortController();
        const frames = yield* ai.chat({
          launch,
          pr: {
            title: pr.title,
            body: pr.body,
            sourceBranch: pr.sourceBranch,
            targetBranch: pr.targetBranch,
          },
          walkthrough: yield* walkthroughContext(pr.id),
          message: params.message,
          attachments: params.attachments,
          history,
          cwd: branch.worktreePath,
          branchName: branch.branchName,
          resumeSessionId: session.sessionId,
          // Awaited before the prompt, so a follow-up turn finds the session.
          onSessionId: (sessionId) =>
            Effect.runPromise(
              chatSessions.setAgentSessionId({
                chatSessionId: session.id,
                sessionId,
                worktreePath: branch.worktreePath,
                branchName: branch.branchName,
              }),
            ),
          prId: pr.id,
          interactionMode: mode,
          abortController: abort,
        });

        return journalTurn({
          source: frames,
          chatSessions,
          chatSessionId: session.id,
          turnId,
          prId: pr.id,
          onProgress: claim.touch,
          stopAgent: () => abort.abort(new Error("Stopped by the user")),
          release: Scope.close(scope, Exit.void),
        });
      });

    return {
      start: (params) =>
        Effect.gen(function* () {
          // The turn outlives the request: its stream closes the scope.
          const scope = yield* Scope.make();
          return yield* prepare(params, scope).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
        }),
    };
  }),
);
