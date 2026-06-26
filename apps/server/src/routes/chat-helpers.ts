// ── Chat helpers ──────────────────────────────────────────────────────────
//
// Pure helper functions extracted from chat.ts. Used by the chat route
// handlers and the proposed-changes / interaction sub-routers.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChatSessionContext } from "@revv/shared";
import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { getAcpConnection, peekAcpConnection } from "../ai/acp/acp-connection";
import { applyAcpAgentOverride } from "../ai/acp/presets";
import type { ChatWalkthroughContext } from "../ai/prompts/chat";
import type { ChatStreamFrame, RawChatStreamFrame } from "../ai/providers/chat-types";
import type { Db } from "../db/index";
import { walkthroughIssues } from "../db/schema/walkthrough-issues";
import { walkthroughs } from "../db/schema/walkthroughs";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import type { ResolvePushFrame } from "../services/ChatChangesPush";
import { type ChatSessionRow, ChatSessionService } from "../services/ChatSession";
import { PROPOSED_COMMIT_RANGE_FLAGS } from "../services/GitOps";
import { PrContextService } from "../services/PrContext";
import { RepoCloneService } from "../services/RepoClone";
import { SettingsService } from "../services/Settings";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Cheap, read-only bootstrap prefix shared by `POST /api/chat` and the
 * `GET /api/chat/:prId/session-context` menu fetch: PR + repo + token, the
 * current head SHA (falling back to a live GitHub meta fetch), the resolved
 * agent/model, and the existing session row.
 *
 * Performs NO writes and NO worktree mutation — crucially it does NOT
 * `acquirePrWorktree` (which fetches + may `reset --hard`), `findOrCreate`,
 * `newSession`, or `setAgentSessionId`. That keeps the menu fetch — which
 * fires on every PR selection — free of git side effects and incapable of
 * racing an in-flight turn writing to the same worktree. The worktree acquire
 * is the POST turn's job (see `resolveChatTurnContext`).
 */
export const resolveChatReadContext = (
  prId: string,
  userId: string,
  opts: { fetchHeadShaFromGithub?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { fetchHeadShaFromGithub = true } = opts;
    const prCtx = yield* PrContextService;
    const settingsService = yield* SettingsService;
    const chatSessions = yield* ChatSessionService;

    const { pr, repo, token } = yield* prCtx.resolveBasic(prId, userId);

    // Resolve current head SHA. When the cached PR row has none, the only way
    // to learn it is a live GitHub meta fetch — expensive and rate-limited, and
    // this resolver fires on every PR selection. Read-only callers (the
    // side-effect-free session-context menu fetch) opt out via
    // `fetchHeadShaFromGithub: false` and tolerate a null head SHA (→ empty
    // menus) rather than pay a GitHub call and risk a 500 on mere PR browsing.
    let headSha: string | null = pr.headSha;
    if (!headSha && fetchHeadShaFromGithub) {
      const meta = yield* prCtx.prMeta(repo.fullName, pr.externalId, token);
      headSha = meta.headSha;
    }

    const settings = yield* settingsService.getSettings();
    const agent = yield* settingsService.resolveChatAgentId();
    const model = settings.aiModel;

    // No head SHA → no session can match (rows are keyed on it), so skip the
    // lookup. Otherwise a null row means a fresh start (e.g. the user just
    // cleared chat) — the POST handler keys its hard-reset off this.
    const existingSessionRow: ChatSessionRow | null = headSha
      ? yield* chatSessions.find(pr.id, agent, model, headSha)
      : null;

    return { pr, repo, token, headSha, settings, agent, model, existingSessionRow };
  });

/**
 * The full turn bootstrap for `POST /api/chat`: the read prefix above plus the
 * per-PR worktree acquire (shared across walkthrough generation and every chat
 * session for this PR). Only the POST turn mutates the worktree; the
 * session-context menu fetch uses {@link resolveChatReadContext} instead.
 */
export const resolveChatTurnContext = (prId: string, userId: string) =>
  Effect.gen(function* () {
    const read = yield* resolveChatReadContext(prId, userId);
    const { headSha } = read;
    if (headSha === null) {
      // Unreachable: the turn path leaves `fetchHeadShaFromGithub` at its
      // default, so `prMeta` either yields a SHA or fails the Effect above.
      // The guard narrows the type for the worktree acquire.
      return yield* Effect.dieMessage("resolveChatTurnContext: head SHA unresolved");
    }
    const repoClone = yield* RepoCloneService;

    const { worktreePath, branchName } = yield* repoClone.acquirePrWorktree({
      repoId: read.repo.id,
      prNumber: read.pr.externalId,
      prHeadSha: headSha,
      githubToken: read.token,
    });

    return { ...read, headSha, worktreePath, branchName };
  });

const EMPTY_SESSION_CONTEXT: ChatSessionContext = {
  commands: [],
  promptImage: false,
  embeddedContext: false,
  repoFiles: [],
};

/**
 * Resolve the composer's `@`-mention / `/`-command context for a PR, behind a
 * single `warm` capability flag instead of re-testing it at each step.
 *
 *   - **Default (`warm: false`).** Side-effect-free: no GitHub head-SHA fetch,
 *     no worktree acquire, no session mutation. Reads an already-warm agent
 *     (`peekAcpConnection` never cold-spawns) and only the commands a prior
 *     turn already cached. Fires on every PR selection, so it must stay cheap.
 *   - **Warm (`warm: true`).** Sent on composer focus (real intent to chat):
 *     acquires the worktree (deduped against a concurrent first turn inside
 *     `acquirePrWorktree`), (re)starts the agent via `getAcpConnection`, and
 *     harvests slash commands through a throwaway, never-persisted session.
 *
 * Returns empty context (rather than erroring) whenever the prerequisites for a
 * given tier are absent — no head SHA, no worktree yet, no warm agent — so the
 * menus degrade to empty rather than failing the request.
 */
export const resolveChatSessionContext = (prId: string, userId: string, warm: boolean) =>
  Effect.gen(function* () {
    const read = yield* resolveChatReadContext(prId, userId, { fetchHeadShaFromGithub: warm });
    const { settings, agent, existingSessionRow } = read;

    // No head SHA → nothing to read (worktree + session rows are keyed on it).
    if (read.headSha === null) return EMPTY_SESSION_CONTEXT;

    // Resolve the worktree: read the one a prior turn created, or — only when
    // warming — acquire it now.
    let worktreePath = existingSessionRow?.worktreePath ?? null;
    if (warm && !(worktreePath && existsSync(worktreePath))) {
      const repoClone = yield* RepoCloneService;
      const acquired = yield* repoClone.acquirePrWorktree({
        repoId: read.repo.id,
        prNumber: read.pr.externalId,
        prHeadSha: read.headSha,
        githubToken: read.token,
      });
      worktreePath = acquired.worktreePath;
    }

    if (!(worktreePath && existsSync(worktreePath))) return EMPTY_SESSION_CONTEXT;

    // Repo files come straight from git — no agent process needed.
    const repoFiles = yield* Effect.promise(() => listRepoFiles(worktreePath));

    // Capabilities + slash commands from the agent connection.
    const acpAgent = applyAcpAgentOverride(agent);
    const config = {
      model: settings.aiModel ?? undefined,
      thinkingEffort: settings.aiThinkingEffort ?? undefined,
      contextWindow: settings.aiContextWindow ?? undefined,
    };
    const handle = yield* Effect.promise(() =>
      warm
        ? getAcpConnection(worktreePath, acpAgent, config)
        : peekAcpConnection(worktreePath, acpAgent, config),
    );
    if (!handle) return { ...EMPTY_SESSION_CONTEXT, repoFiles };

    // Slash commands are cached against a live session id, populated as the
    // agent streams `available_commands_update`; harvest fresh only when warming.
    const sessionId = existingSessionRow?.sessionId ?? null;
    let raw = sessionId ? handle.getAvailableCommands(sessionId) : [];
    if (raw.length === 0 && warm) {
      raw = yield* Effect.promise(() => handle.listAvailableCommands());
    }

    return {
      commands: raw.map((command) => ({ name: command.name, description: command.description })),
      promptImage: handle.promptImage,
      embeddedContext: handle.embeddedContext,
      repoFiles,
    } satisfies ChatSessionContext;
  });

/**
 * Best-effort fetch of the latest completed walkthrough's summary, risk,
 * sentiment, and issues for a PR. Returns null on any failure or if no
 * complete walkthrough exists. Used only on chat-session creation — the
 * system prompt is embedded once and the agent retains it.
 */
export function fetchWalkthroughContext(db: Db, prId: string): ChatWalkthroughContext | null {
  try {
    const wtRow = db
      .select()
      .from(walkthroughs)
      .where(and(eq(walkthroughs.pullRequestId, prId), eq(walkthroughs.status, "complete")))
      .orderBy(desc(walkthroughs.generatedAt))
      .limit(1)
      .get();
    if (!wtRow) return null;

    const issues = db
      .select()
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, wtRow.id))
      .orderBy(walkthroughIssues.order)
      .limit(40)
      .all();

    return {
      summary: wtRow.summary ?? "",
      riskLevel: wtRow.riskLevel ?? "low",
      sentiment: wtRow.sentiment ?? null,
      issues: issues.map((i) => ({
        severity: i.severity,
        title: i.title,
        description: i.description,
        filePath: i.filePath,
        startLine: i.startLine,
        endLine: i.endLine,
      })),
    };
  } catch (err) {
    logError(
      "chat",
      "walkthrough lookup failed (best-effort):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Run a git command in `cwd` and return its stdout. Throws on non-zero exit
 * or timeout. Used by the proposed-changes endpoints — they don't share
 * `runGit` from RepoClone.ts because that one swallows stdout.
 */
export function gitStdout(args: string[], cwd: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr?.on("data", (c: Buffer) => errChunks.push(c));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`git ${args[0] ?? ""} timed out`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      } else {
        reject(
          new Error(
            `git ${args[0] ?? ""} failed: ${Buffer.concat(errChunks).toString("utf-8").trim()}`,
          ),
        );
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function listRepoFiles(worktreePath: string): Promise<string[]> {
  const stdout = await gitStdout(["ls-tree", "-r", "--name-only", "-z", "HEAD"], worktreePath);
  return stdout.split("\0").filter((path) => path.length > 0);
}

/**
 * Returns the contents of `<sha>:<path>` or `null` if git fails (typically
 * because the path doesn't exist at that revision — e.g. asking for a
 * newly-added file at the parent commit).
 */
export async function gitShowSafe(sha: string, path: string, cwd: string): Promise<string | null> {
  try {
    return await gitStdout(["show", `${sha}:${path}`], cwd, 10_000);
  } catch {
    return null;
  }
}

/**
 * Best-effort git command runner — ignores all errors. Used for cleanup
 * operations like `rebase --abort` where we want to clean up after a
 * failure without risking a secondary error obscuring the first.
 */
export async function gitStdoutBestEffort(args: string[], cwd: string): Promise<void> {
  try {
    await gitStdout(args, cwd, 10_000);
  } catch {
    // Intentionally swallowed — best-effort only.
  }
}

/**
 * Rewind a chat worktree back to the PR's head SHA, discarding any unpushed
 * agent commits sitting on top.
 *
 * This is load-bearing for the "clear conversation" flow: if it silently
 * fails, the agent's old commits stay on the local branch and
 * `acquirePrWorktree` preserves them on the next turn (its `merge-base
 * --is-ancestor` check is exit-0, so the descendant tip is kept by design).
 * The user then sees the *exact same SHAs* re-appear in the proposed-changes
 * strip after clearing — which is the bug this helper exists to prevent.
 *
 * Three failure modes are handled defensively:
 *   1. Stale `index.lock` / `HEAD.lock` from a SIGTERM'd agent turn — removed
 *      before reset so it doesn't trip with "Unable to create '.../index.lock'".
 *   2. Mid-merge / mid-rebase state from a SIGKILL'd merge-push — aborted
 *      best-effort so the MERGE_HEAD / rebase-merge dir doesn't poison reset.
 *   3. Detached HEAD (worktree somehow not on the expected branch ref) —
 *      reattach the branch ref to prHeadSha via `update-ref` and re-point
 *      HEAD via `symbolic-ref`, so subsequent `acquirePrWorktree` sees a
 *      clean branch checkout at the right SHA.
 *
 * Post-reset we verify HEAD matches `prHeadSha` and log loudly on mismatch
 * — silent reset failures were the original bug.
 */
export async function discardAgentCommits(opts: {
  worktreePath: string;
  branchName: string;
  prHeadSha: string;
}): Promise<void> {
  const { worktreePath, branchName, prHeadSha } = opts;

  // 1. Clear any lock files. A leftover index.lock from an aborted agent
  // turn is the single most common reason `reset --hard` fails on this
  // worktree. The lockfile lives next to the worktree's gitdir, which
  // sits inside the clone path, not the worktree itself — `git rev-parse
  // --git-dir` resolves it.
  let gitDir: string | null = null;
  try {
    gitDir = (await gitStdout(["rev-parse", "--git-dir"], worktreePath, 5_000)).trim();
  } catch (err) {
    logError(
      "chat-clear",
      "rev-parse --git-dir failed (worktree likely corrupt):",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(worktreePath, gitDir);
  for (const lockName of ["index.lock", "HEAD.lock"]) {
    const lockPath = join(absoluteGitDir, lockName);
    try {
      if (existsSync(lockPath)) {
        await rm(lockPath, { force: true });
      }
    } catch (err) {
      logError(
        "chat-clear",
        `failed to clear stale ${lockName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 2. Abort any half-finished merge/rebase. Both fail when nothing is in
  // progress — that's fine, we're using the best-effort variant.
  await gitStdoutBestEffort(["merge", "--abort"], worktreePath);
  await gitStdoutBestEffort(["rebase", "--abort"], worktreePath);
  await gitStdoutBestEffort(["cherry-pick", "--abort"], worktreePath);

  // 3. Ensure HEAD points at the branch ref (not a detached commit). If
  // HEAD is detached, `reset --hard` only moves HEAD — the branch ref
  // keeps its old tip, so acquirePrWorktree later reattaches to the old
  // tip via `worktree add`. Pointing HEAD at the branch first means the
  // reset below updates both the working tree and the branch ref atomically.
  try {
    const headRef = (
      await gitStdout(["symbolic-ref", "--quiet", "HEAD"], worktreePath, 5_000).catch(() => "")
    ).trim();
    if (headRef !== `refs/heads/${branchName}`) {
      await gitStdoutBestEffort(["symbolic-ref", "HEAD", `refs/heads/${branchName}`], worktreePath);
    }
  } catch (err) {
    logError(
      "chat-clear",
      "failed to verify/reattach HEAD:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 4. The reset itself. This is the load-bearing line — everything above
  // is just clearing obstacles. We log the actual git failure so we can
  // diagnose silent-failure regressions like the one that motivated this
  // helper.
  try {
    await gitStdout(["reset", "--hard", prHeadSha], worktreePath, 30_000);
  } catch (err) {
    logError(
      "chat-clear",
      `reset --hard ${prHeadSha} failed in ${worktreePath}:`,
      err instanceof Error ? err.message : String(err),
    );
    // Fall through to verification — even a failed reset may have
    // partially worked, and we want the log to capture the final state.
  }

  // 5. Drop any untracked files the agent created but never committed.
  // Without this, the next chat session inherits ghost files in the
  // worktree that confuse `git status` and the agent's own context.
  await gitStdoutBestEffort(["clean", "-fd"], worktreePath);

  // 6. Verify. If HEAD didn't end up at prHeadSha the next chat turn
  // will reproduce the original bug (same SHAs reappear) — emit a loud
  // log so the regression is visible without strace-level debugging.
  try {
    const finalSha = (await gitStdout(["rev-parse", "HEAD"], worktreePath, 5_000)).trim();
    if (finalSha !== prHeadSha) {
      logError(
        "chat-clear",
        `worktree rewind did not land at prHeadSha. ` +
          `expected=${prHeadSha} got=${finalSha} worktree=${worktreePath}`,
      );
    }
  } catch (err) {
    logError(
      "chat-clear",
      "post-reset HEAD verification failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface ProposedCommit {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt: string;
  files: string[];
}

/**
 * Wrap the provider's frame stream so each frame is persisted to SQLite as
 * it passes through, then re-emitted to the SSE encoder unchanged.
 *
 * Persistence rules:
 *   - text frames: lazily begin the assistant message on the FIRST chunk
 *     (so the assistant row's sequence lands AFTER any preceding activities,
 *     matching the "user → activities → assistant" timeline shape). Each
 *     subsequent chunk appends content via SQL `||`.
 *   - activity frames: insert a chat_activities row immediately, sequence
 *     allocated atomically against chat_sessions.next_sequence.
 *   - stream end (no error): finalize the assistant message if one exists;
 *     if no text frames ever arrived, create a placeholder assistant row
 *     so the timeline always closes the turn (the user may have only
 *     received tool activity).
 *   - stream error: same as success but populates the assistant message's
 *     `error` column with the inline-error chip text.
 *
 * Persistence is best-effort: if a single insert fails the stream still
 * forwards the frame to the client. Logging the failure keeps us honest
 * about partial state without breaking the user's turn.
 */
export function wrapStreamWithPersistence(
  source: ReadableStream<RawChatStreamFrame>,
  ctx: { chatSessionId: string; turnId: string; agent: "acp" },
): ReadableStream<ChatStreamFrame> {
  return new ReadableStream<ChatStreamFrame>({
    async start(controller) {
      const reader = source.getReader();
      let assistantMessageId: string | null = null;
      let textStreamed = false;
      // Provider call id → server-assigned invocation id. Activity
      // frames stamped with subagentProviderCallId are translated to
      // subagentInvocationId here so the wire shape uses server ids
      // throughout.
      const providerToInvocationId = new Map<string, string>();
      // Provider request id → server-assigned question id. Used to map
      // opencode's `question.replied` event back to the row created on
      // the prior `question.asked` so the resolution frame carries the
      // server id rather than the provider's request id.
      const providerRequestIdToQuestionId = new Map<string, string>();

      /** Best-effort log for persistence failures — never breaks the stream. */
      const logPersistError = (op: string, err: unknown): void => {
        logError("chat", `${op} failed:`, err instanceof Error ? err.message : String(err));
      };

      const ensureAssistantMessage = async (): Promise<string> => {
        if (assistantMessageId) return assistantMessageId;
        try {
          const { id } = await AppRuntime.runPromise(
            Effect.flatMap(ChatSessionService, (svc) =>
              svc.beginAssistantMessage({
                chatSessionId: ctx.chatSessionId,
                turnId: ctx.turnId,
              }),
            ),
          );
          assistantMessageId = id;
        } catch (err) {
          logPersistError("beginAssistantMessage", err);
          // Surface a synthetic id so downstream calls don't keep
          // trying. They'll silently no-op against a non-existent
          // row, which we tolerate over crashing the stream.
          assistantMessageId = "";
        }
        return assistantMessageId;
      };

      const finalize = async (errorMessage: string | null): Promise<void> => {
        try {
          if (!assistantMessageId && errorMessage) {
            // Errored before any text arrived — still record an
            // assistant row so the inline-error chip renders on
            // reload.
            await AppRuntime.runPromise(
              Effect.flatMap(ChatSessionService, (svc) =>
                svc.beginAssistantMessage({
                  chatSessionId: ctx.chatSessionId,
                  turnId: ctx.turnId,
                }),
              ).pipe(
                Effect.tap(({ id }) =>
                  Effect.flatMap(ChatSessionService, (svc) =>
                    svc.finalizeAssistantMessage({
                      messageId: id,
                      error: errorMessage,
                    }),
                  ),
                ),
              ),
            );
          } else if (assistantMessageId) {
            const msgId = assistantMessageId;
            await AppRuntime.runPromise(
              Effect.flatMap(ChatSessionService, (svc) =>
                svc.finalizeAssistantMessage({
                  messageId: msgId,
                  error: errorMessage,
                }),
              ),
            );
          }
        } catch (err) {
          logPersistError("finalizeAssistantMessage", err);
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.kind === "text") {
            textStreamed = true;
            const id = await ensureAssistantMessage();
            if (id) {
              try {
                await AppRuntime.runPromise(
                  Effect.flatMap(ChatSessionService, (svc) =>
                    svc.appendAssistantContent({
                      messageId: id,
                      chunk: value.data,
                    }),
                  ),
                );
              } catch (err) {
                logPersistError("appendAssistantContent", err);
              }
            }
          } else if (value.kind === "activity") {
            const subagentInvocationId = value.subagentProviderCallId
              ? (providerToInvocationId.get(value.subagentProviderCallId) ?? null)
              : null;
            try {
              await AppRuntime.runPromise(
                Effect.flatMap(ChatSessionService, (svc) =>
                  svc.appendActivity({
                    chatSessionId: ctx.chatSessionId,
                    turnId: ctx.turnId,
                    activityKind: value.activityKind,
                    toolName: value.toolName,
                    summary: value.summary,
                    payload: value.payload,
                    subagentInvocationId,
                  }),
                ),
              );
            } catch (err) {
              logPersistError("appendActivity", err);
            }
            // Translate Raw → Wire: drop the providerCallId field,
            // add server-side subagentInvocationId when present.
            const { subagentProviderCallId: _unused, ...activityRest } = value;
            void _unused;
            const wireActivity: ChatStreamFrame = subagentInvocationId
              ? { ...activityRest, subagentInvocationId }
              : activityRest;
            controller.enqueue(wireActivity);
            continue;
          } else if (value.kind === "task-list") {
            try {
              await AppRuntime.runPromise(
                Effect.flatMap(ChatSessionService, (svc) =>
                  svc.applyTaskListSnapshot({
                    chatSessionId: ctx.chatSessionId,
                    turnId: ctx.turnId,
                    source: ctx.agent,
                    tasks: value.tasks,
                  }),
                ),
              );
            } catch (err) {
              logPersistError("applyTaskListSnapshot", err);
            }
            controller.enqueue({
              kind: "task-list",
              turnId: ctx.turnId,
              tasks: value.tasks,
            });
            continue;
          } else if (value.kind === "plan-presented") {
            let planId: string | null = null;
            try {
              const plan = await AppRuntime.runPromise(
                Effect.flatMap(ChatSessionService, (svc) =>
                  svc.createPlan({
                    chatSessionId: ctx.chatSessionId,
                    turnId: ctx.turnId,
                    source: ctx.agent,
                    markdown: value.markdown,
                  }),
                ),
              );
              planId = plan.id;
            } catch (err) {
              logPersistError("createPlan", err);
            }
            if (planId) {
              controller.enqueue({
                kind: "plan-presented",
                planId,
                turnId: ctx.turnId,
                markdown: value.markdown,
                status: "pending",
              });
            }
            continue;
          } else if (value.kind === "subagent-start") {
            let invocationId: string | null = null;
            try {
              const { invocationId: id } = await AppRuntime.runPromise(
                Effect.flatMap(ChatSessionService, (svc) =>
                  svc.startSubagentInvocation({
                    chatSessionId: ctx.chatSessionId,
                    parentTurnId: ctx.turnId,
                    source: ctx.agent,
                    providerCallId: value.providerCallId,
                    subagentType: value.subagentType,
                    description: value.description,
                    prompt: value.prompt,
                  }),
                ),
              );
              invocationId = id;
              providerToInvocationId.set(value.providerCallId, id);
            } catch (err) {
              logPersistError("startSubagentInvocation", err);
            }
            if (invocationId) {
              controller.enqueue({
                kind: "subagent-start",
                invocationId,
                parentTurnId: ctx.turnId,
                subagentType: value.subagentType,
                description: value.description,
              });
            }
            continue;
          } else if (value.kind === "subagent-end") {
            const invocationId = providerToInvocationId.get(value.providerCallId);
            if (invocationId) {
              try {
                await AppRuntime.runPromise(
                  Effect.flatMap(ChatSessionService, (svc) =>
                    svc.completeSubagentInvocation({
                      invocationId,
                      result: value.result,
                      ok: value.ok,
                    }),
                  ),
                );
              } catch (err) {
                logPersistError("completeSubagentInvocation", err);
              }
              controller.enqueue({
                kind: "subagent-end",
                invocationId,
                result: value.result,
                ok: value.ok,
              });
            }
            continue;
          } else if (value.kind === "user-question") {
            let questionId: string | null = null;
            try {
              const row = await AppRuntime.runPromise(
                Effect.flatMap(ChatSessionService, (svc) =>
                  svc.createQuestion({
                    chatSessionId: ctx.chatSessionId,
                    turnId: ctx.turnId,
                    source: ctx.agent,
                    providerRequestId: value.providerRequestId,
                    providerToolCallId: value.providerToolCallId ?? null,
                    previewFormat: value.previewFormat,
                    questions: value.questions,
                  }),
                ),
              );
              questionId = row.id;
              providerRequestIdToQuestionId.set(value.providerRequestId, row.id);
            } catch (err) {
              logPersistError("createQuestion", err);
            }
            if (questionId) {
              controller.enqueue({
                kind: "user-question",
                questionId,
                turnId: ctx.turnId,
                questions: value.questions,
                previewFormat: value.previewFormat,
                status: "pending",
              });
            }
            continue;
          } else if (value.kind === "user-question-resolved") {
            // Opencode-only: the daemon broadcasts replied/rejected
            // AFTER our /answer endpoint has already POSTed back to
            // it. The endpoint already wrote the DB row, so this
            // path is idempotent — `decideQuestion` no-ops when the
            // row is already non-pending.
            const questionId = providerRequestIdToQuestionId.get(value.providerRequestId);
            if (questionId) {
              try {
                await AppRuntime.runPromise(
                  Effect.flatMap(ChatSessionService, (svc) =>
                    svc.decideQuestion({
                      questionId,
                      status: value.status,
                      ...(value.answers !== undefined ? { answers: value.answers } : {}),
                    }),
                  ),
                );
              } catch (err) {
                logPersistError("decideQuestion", err);
              }
              controller.enqueue({
                kind: "user-question-resolved",
                questionId,
                status: value.status,
                ...(value.answers !== undefined ? { answers: value.answers } : {}),
              });
            }
            continue;
          }

          controller.enqueue(value as ChatStreamFrame);
        }

        // Stream ended cleanly. If no text was streamed but the agent
        // did emit activities or completed silently, still close out
        // the turn with a placeholder row so the timeline is
        // well-formed on reload.
        if (!textStreamed && !assistantMessageId) {
          await ensureAssistantMessage();
        }
        await finalize(null);
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream error";
        await finalize(msg);
        controller.error(err);
      }
    },
  });
}

export async function listProposedCommits(
  worktreePath: string,
  prHeadSha: string,
): Promise<ProposedCommit[]> {
  const range = `${prHeadSha}..HEAD`;
  const log = await gitStdout(
    [
      "log",
      // Same traversal as every other proposed-commit enumeration: stay on the
      // agent branch's first-parent line and skip merges, so a `merge
      // origin/main` to refresh the branch doesn't surface the entire base
      // history as bogus proposed commits. See PROPOSED_COMMIT_RANGE_FLAGS.
      ...PROPOSED_COMMIT_RANGE_FLAGS,
      range,
      // %x09 = tab; we emit one line per commit then a blank line.
      "--pretty=format:%H%x09%s%x09%aI",
    ],
    worktreePath,
  );
  const lines = log.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const commits: ProposedCommit[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [sha, subject, committedAt] = parts as [string, string, string];
    const namesOut = await gitStdout(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
      worktreePath,
    ).catch(() => "");
    const files = namesOut.split("\n").filter((f) => f.length > 0);
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      subject,
      committedAt,
      files,
    });
  }
  return commits;
}

/**
 * Wrap a ResolvePushFrame stream into SSE bytes. Mirrors the shape of
 * `chatStreamToSSE` so the web client can reuse `parseSSEBuffer`.
 */
export function resolvePushStreamToSSE(
  frameStream: ReadableStream<ResolvePushFrame>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = frameStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const errMsg = JSON.stringify({
          code: "GENERATION_ERROR",
          message: err instanceof Error ? err.message : "Unknown error",
        });
        controller.enqueue(encoder.encode(`event: error\ndata: ${errMsg}\n\n`));
        controller.close();
      }
    },
  });
}
