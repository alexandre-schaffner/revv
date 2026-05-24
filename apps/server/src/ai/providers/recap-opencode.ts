// ─── recap-opencode ──────────────────────────────────────────────────────────
//
// Opencode driver for project-recap generation. Mirrors the walkthrough's
// `mcp-walkthrough-opencode.ts` but smaller:
//
//   • Structured pipeline (`set_lede` + `add_pr_entry × N` + `complete_recap`)
//     with no text buffer — all content flows through tool args.
//   • SSE subscriber (`subscribeOpencodeStream`) forwards reasoning deltas
//     as `thought` events and tool calls as `activity` events. Visible
//     assistant text is discarded because the agent isn't supposed to emit
//     any between tool calls in this pipeline.
//   • Per CLAUDE.md invariant #13, the MCP tool handlers invoked by the
//     daemon run through the SAME shared handlers the Claude SDK path
//     uses (`apps/server/src/ai/providers/recap-tools/handlers.ts`).
//     The HTTP route at `/mcp/recap` resolves the bearer token to the
//     per-job context and dispatches.
//
// Lifecycle:
//   1. Ask the OpencodeSupervisor for a running daemon (lazy-started).
//   2. Issue a session token in `ProjectRecapJobs` bound to the prepared
//      `RecapToolContext` (recapId + sourceBundle + priorRecaps +
//      onCompleted hook).
//   3. Register `/mcp/recap` as a remote MCP server on the daemon via
//      `client.mcp.add` with the bearer token in the connection headers.
//   4. Create an opencode session, subscribe to `/global/event` SSE, and
//      post the recap prompt. SSE forwards text-deltas live; the agent's
//      tool calls hit the HTTP MCP route directly.
//   5. Aggregate token usage from `response.parts` step-finish frames +
//      the final `response.info.tokens` snapshot.
//   6. Clear the session token in `finally`.
//
// `withAgentTurn` wires the abort + 10-min hard timeout into the daemon's
// `client.session.abort` so a cancel/timeout tears down the model run.

import type { Part } from "@opencode-ai/sdk/v2";
import type { RecapStreamEvent } from "@revv/shared";
import { serverEnv } from "../../config";
import { debug, logError } from "../../logger";
import {
  extractOpencodeErrorMessage,
  parseOpencodeModel,
  subscribeOpencodeStream,
  walkOpencodePartsWithState,
  withAgentTurn,
} from "../agent-stream";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../prompts/recap";
import { createRecapDispatchState, dispatchRecapStreamEvent } from "./recap-event-dispatch";
import type { RecapToolContext } from "./recap-tools";
import { RECAP_MCP_SERVER } from "./recap-tools";

// ── Public types ─────────────────────────────────────────────────────────────

export interface RecapOpencodeSupervisorDeps {
  /** Ensure the daemon is running; returns credentials + bound port. */
  readonly ensureDaemon: () => Promise<{
    readonly port: number;
    readonly hostname: string;
    readonly password: string;
  }>;
  /** Bump the daemon's active-job refcount (cancels idle timer). */
  readonly jobStarted: () => Promise<void>;
  /** Decrement the daemon's active-job refcount (may schedule idle stop). */
  readonly jobEnded: () => Promise<void>;
  /** Fetch the current SDK client. Null when the daemon isn't running. */
  // biome-ignore lint/suspicious/noExplicitAny: SDK client type is internal to OpencodeSupervisor.
  readonly client: () => Promise<any | null>;
}

export interface RecapOpencodeSessionDeps {
  /** Mint a bearer token scoped to this recap job. */
  readonly issueSessionToken: (ctx: RecapToolContext) => Promise<string>;
  /** Invalidate the token when we're done (or aborted). */
  readonly clearSessionToken: (token: string) => Promise<void>;
}

export interface RunRecapAgentOpencodeParams {
  readonly ctx: RecapToolContext;
  readonly modelUsed: string;
  /** Server-side cwd handed to `client.session.create({ directory })`. */
  readonly workingDir: string;
  readonly abortController: AbortController;
  readonly supervisorDeps: RecapOpencodeSupervisorDeps;
  readonly sessionDeps: RecapOpencodeSessionDeps;
}

export interface RecapOpencodeResult {
  readonly tokenUsage?: Record<string, number>;
  /** Error message when the daemon reports a failed run. */
  readonly error?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** 10-minute soft cap, matches the Claude SDK path's setTimeout in recap-agent-runner. */
const RECAP_OPENCODE_HARD_TIMEOUT_MS = 10 * 60_000;

// ── Driver ───────────────────────────────────────────────────────────────────

/**
 * Run a single recap agent turn against the opencode daemon. Resolves to
 * a token-usage snapshot (best-effort) once the model finishes or the
 * abort signal fires. The `onCompleted` hook on the context flips
 * `validatedComplete` in the orchestrator when `complete_recap` succeeds —
 * the caller observes that flag separately, not this return value.
 */
export async function runRecapAgentViaOpencode(
  params: RunRecapAgentOpencodeParams,
): Promise<RecapOpencodeResult> {
  let sessionToken: string | null = null;
  let sessionId: string | null = null;
  let validatedCompleteSeen = false;

  const userMessage = buildRecapUserMessage(params.ctx.sourceBundle, params.ctx.priorRecaps);

  try {
    return await withAgentTurn<RecapOpencodeResult>({
      externalAbort: params.abortController,
      hardTimeoutMs: RECAP_OPENCODE_HARD_TIMEOUT_MS,
      jobStarted: params.supervisorDeps.jobStarted,
      jobEnded: params.supervisorDeps.jobEnded,
      debugLabel: "recap-opencode",
      abortSession: async () => {
        if (!sessionId) return;
        const client = await params.supervisorDeps.client();
        if (!client) return;
        // Omitting `throwOnError` so the 404-after-natural-end race surfaces
        // as `result.error` rather than throwing.
        const abortResult = await client.session.abort({ sessionID: sessionId });
        if (abortResult.error) {
          const status = abortResult.response?.status;
          if (status !== 404) {
            logError("recap-opencode", `abortSession non-ok (${status})`);
          }
        }
      },
      run: async (ctx) => {
        const endpoint = await params.supervisorDeps.ensureDaemon();
        const client = await params.supervisorDeps.client();
        if (!client) {
          throw new Error("OpencodeSupervisor reports daemon-running but no HTTP client available");
        }

        let resolveValidatedComplete: (() => void) | null = null;
        const validatedComplete = new Promise<void>((resolve) => {
          resolveValidatedComplete = resolve;
        });

        let completionAbortTimer: ReturnType<typeof setTimeout> | null = null;
        const abortAfterValidatedComplete = (): void => {
          if (completionAbortTimer !== null) return;
          completionAbortTimer = setTimeout(() => {
            if (!sessionId) return;
            void client.session
              .abort({ sessionID: sessionId })
              .then((result: { error?: unknown; response?: { status?: number } }) => {
                if (result.error && result.response?.status !== 404) {
                  logError("recap-opencode", "abort-after-complete non-ok");
                }
              })
              .catch((err: unknown) => {
                logError(
                  "recap-opencode",
                  "abort-after-complete failed:",
                  err instanceof Error ? err.message : String(err),
                );
              });
          }, 0);
        };

        const toolCtx: RecapToolContext = {
          ...params.ctx,
          onCompleted: () => {
            validatedCompleteSeen = true;
            params.ctx.onCompleted();
            resolveValidatedComplete?.();
            abortAfterValidatedComplete();
          },
        };

        // ── 1. Issue session token + register MCP server ──────────
        sessionToken = await params.sessionDeps.issueSessionToken(toolCtx);
        const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/recap`;
        const mcpServerName = `${RECAP_MCP_SERVER}-${params.ctx.recapId}`;
        debug(
          "recap-opencode",
          `registering MCP ${mcpServerName} → ${mcpUrl}`,
          "endpoint:",
          `${endpoint.hostname}:${endpoint.port}`,
        );
        const mcpResult = await client.mcp.add({
          directory: params.workingDir,
          name: mcpServerName,
          config: {
            type: "remote",
            url: mcpUrl,
            headers: { Authorization: `Bearer ${sessionToken}` },
          },
        });
        if (mcpResult.error) {
          const detail =
            (mcpResult.error as { data?: { message?: string } }).data?.message ?? "unknown error";
          throw new Error(`opencode mcp.add failed: ${detail}`);
        }
        const mcpEntry = mcpResult.data?.[mcpServerName];
        if (!mcpEntry) {
          throw new Error(`opencode mcp.add returned no status for '${mcpServerName}'`);
        }
        if (mcpEntry.status !== "connected") {
          throw new Error(
            `opencode mcp.add: '${mcpServerName}' status=${mcpEntry.status}${
              "error" in mcpEntry && typeof mcpEntry.error === "string"
                ? ` — ${mcpEntry.error}`
                : ""
            }`,
          );
        }
        debug("recap-opencode", `MCP registration succeeded`);

        // ── 2. Create opencode session ────────────────────────────
        const created = await client.session.create(
          {
            directory: params.workingDir,
            title: `recap-${params.ctx.recapId}`,
          },
          { throwOnError: true },
        );
        const turnSessionId: string = created.data.id;
        sessionId = turnSessionId;
        debug("recap-opencode", "created session:", turnSessionId);

        // ── 3. Subscribe to /global/event SSE for live tool calls ──
        //
        // All recap content flows through tool args under the structured
        // pipeline; visible assistant text is discarded. Per CLAUDE.md
        // invariant #13, both transports exhibit identical externally-
        // observable behavior — see `recap-agent-runner.ts` for the
        // matching Claude SDK path.
        const sseAbort = new AbortController();
        // Shared dedup state with the backstop walk below — anything
        // SSE already streamed is skipped when we walk response.parts.
        const emittedTextLen = new Map<string, number>();
        const seenToolPartIds = new Set<string>();
        const userMessageIDs = new Set<string>();
        const fanOutEvent = (event: RecapStreamEvent): void => {
          if (validatedCompleteSeen) return;
          try {
            params.ctx.emit(event);
          } catch (err) {
            logError(
              "recap-opencode",
              `ctx.emit threw for event type=${event.type}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        };
        const dispatchState = createRecapDispatchState();
        const sseDone = subscribeOpencodeStream(
          client,
          turnSessionId,
          sseAbort.signal,
          (ev) => {
            // The opencode transport additionally surfaces user-question /
            // error frames it wants to log; everything else routes through
            // the shared recap dispatcher to stay byte-identical with the
            // Claude SDK path.
            if (ev.kind === "user-question-asked") {
              logError(
                "recap-opencode",
                `session ${turnSessionId} asked a question — this will block until answered/rejected.`,
                JSON.stringify(ev.questions),
              );
              return;
            }
            if (ev.kind === "error") {
              logError("recap-opencode", `session.error: ${ev.message}`);
              return;
            }
            dispatchRecapStreamEvent(ev, dispatchState, fanOutEvent);
          },
          {
            emittedTextLen,
            seenToolPartIds,
            userMessageIDs,
          },
        );

        const onTurnAbort = (): void => sseAbort.abort();
        if (ctx.signal.aborted) onTurnAbort();
        else ctx.signal.addEventListener("abort", onTurnAbort, { once: true });

        // ── 4. Post the prompt and drain ──────────────────────────
        const wireModel = parseOpencodeModel(params.modelUsed);
        debug(
          "recap-opencode",
          `posting prompt to session ${turnSessionId}`,
          "model:",
          params.modelUsed,
          "wire:",
          wireModel ?? "(default)",
        );
        const promptAbort = new AbortController();
        const onPromptAbort = (): void => promptAbort.abort(ctx.signal.reason);
        if (ctx.signal.aborted) onPromptAbort();
        else ctx.signal.addEventListener("abort", onPromptAbort, { once: true });

        const promptPromise = client.session
          .prompt(
            {
              sessionID: turnSessionId,
              directory: params.workingDir,
              parts: [{ type: "text", text: userMessage }],
              system: RECAP_SYSTEM_PROMPT,
              ...(wireModel !== undefined ? { model: wireModel } : {}),
            },
            { signal: promptAbort.signal, throwOnError: true },
          )
          .finally(() => {
            ctx.signal.removeEventListener("abort", onPromptAbort);
            ctx.signal.removeEventListener("abort", onTurnAbort);
            sseAbort.abort();
          });

        const promptResult = await Promise.race([
          promptPromise,
          validatedComplete.then(() => {
            promptAbort.abort(new Error("Recap completed"));
            sseAbort.abort();
            return null;
          }),
        ]);
        if (promptResult === null) {
          promptPromise.catch(() => {
            /* prompt was intentionally aborted after complete_recap */
          });
          debug(
            "recap-opencode",
            `validated complete for session ${turnSessionId}; returning early`,
          );
          return {};
        }
        debug("recap-opencode", `prompt returned for session ${turnSessionId}`);

        // Safety: if the SSE subscription is still alive (idle-stream
        // abort-guard bug in some daemon versions), force-close it so
        // `await sseDone` can't hold the turn past the hard timeout.
        const sseClose = new Promise<void>((resolve, reject) => {
          sseDone.then(resolve, reject);
          // After 5s the drain window has elapsed; if it's still open,
          // something is wrong — resolve so we don't hang.
          setTimeout(() => {
            if (!sseAbort.signal.aborted) sseAbort.abort();
            resolve();
          }, 5_000);
        });
        await sseClose;

        const response = promptResult.data;

        // opencode returns 200 even when the agent loop fails (model not
        // found, provider auth missing). Surface the embedded error so
        // callers see a real failure instead of silent empty content.
        const errObj = response.info.error;
        if (errObj) {
          if (validatedCompleteSeen) {
            return {};
          }
          return { error: `opencode agent error: ${extractOpencodeErrorMessage(errObj)}` };
        }

        // Backstop walk: emit anything SSE missed via the synchronous
        // response body. Shared dedup state makes this a no-op for
        // anything SSE already streamed (the common case). Visible text
        // is discarded; tool calls become `activity` events.
        walkOpencodePartsWithState(
          response.parts,
          {
            emittedTextLen,
            seenToolPartIds,
            userMessageIDs,
            assistantMessageID: response.info.id,
          },
          (ev) => {
            if (ev.kind === "error") {
              logError("recap-opencode", `backstop error: ${ev.message}`);
              return;
            }
            dispatchRecapStreamEvent(ev, dispatchState, fanOutEvent);
          },
        );

        // ── 5. Inspect response.parts for tool calls ──────────────
        //
        // If the model returned text/reasoning but zero tool parts, it
        // does not support tool calling (or the provider isn't configured
        // for it). Fail fast so the orchestrator can mark the job error
        // and the UI doesn't hang on "analyzing".
        const textParts = response.parts.filter((p: Part) => p.type === "text");
        const reasoningParts = response.parts.filter((p: Part) => p.type === "reasoning");
        const toolParts = response.parts.filter((p: Part) => p.type === "tool");
        debug(
          "recap-opencode",
          `response.parts: total=${response.parts.length} text=${textParts.length} reasoning=${reasoningParts.length} tool=${toolParts.length}`,
        );

        if (toolParts.length === 0) {
          const preview = textParts
            .map((p: Part) => (p.type === "text" ? p.text : ""))
            .join("")
            .slice(0, 400);
          const msg =
            `The model finished without calling any tools (${textParts.length} text + ${reasoningParts.length} reasoning part(s)). ` +
            `This usually means the selected model (${params.modelUsed}) does not support tool calling through the opencode daemon, ` +
            `or the provider is not configured for it. Preview: "${preview}"`;
          logError("recap-opencode", msg);
          params.ctx.emit({ type: "error", data: { code: "NoToolCalls", message: msg } });
          return { error: msg };
        }

        // ── 6. Aggregate token usage ──────────────────────────────
        //
        // opencode reports `info.tokens` per CALL, not per turn. A recap
        // typically uses 2–4 calls (read, read, write, complete). Sum
        // `output + reasoning + cache.write` across messages; take the
        // latest message's `input` and `cache.read` since those grow
        // monotonically with history. Same rule as the walkthrough
        // driver, condensed.
        interface MsgSnap {
          input: number;
          output: number;
          reasoning: number;
          cacheRead: number;
          cacheWrite: number;
        }
        const perMessage = new Map<string, MsgSnap>();
        const messageOrder: string[] = [];
        const updateSnap = (
          messageId: string,
          tokens: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          },
        ): void => {
          if (!perMessage.has(messageId)) messageOrder.push(messageId);
          perMessage.set(messageId, {
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cacheRead: tokens.cache.read,
            cacheWrite: tokens.cache.write,
          });
        };

        for (const part of response.parts) {
          if (part.type === "step-finish") {
            updateSnap(part.messageID, part.tokens);
          }
        }
        // Final message snapshot supersedes earlier step-finish for the
        // same messageID.
        updateSnap(response.info.id, response.info.tokens);

        let outputSum = 0;
        let cacheWriteSum = 0;
        for (const m of perMessage.values()) {
          outputSum += m.output + m.reasoning;
          cacheWriteSum += m.cacheWrite;
        }
        const latestId = messageOrder[messageOrder.length - 1];
        const latest = latestId !== undefined ? perMessage.get(latestId) : undefined;
        const tokenUsage: Record<string, number> = {
          input_tokens: latest?.input ?? 0,
          output_tokens: outputSum,
          cache_read_input_tokens: latest?.cacheRead ?? 0,
          cache_creation_input_tokens: cacheWriteSum,
        };

        debug(
          "recap-opencode",
          `prompt drained: parts=${response.parts.length} input=${tokenUsage.input_tokens} output=${tokenUsage.output_tokens}`,
        );

        return { tokenUsage };
      },
    });
  } catch (err) {
    if (validatedCompleteSeen) {
      // If `complete_recap` validated, we intentionally abort the remote
      // session to stop opencode from continuing into another loop.
      return {};
    }
    const message = err instanceof Error ? err.message : String(err);
    logError("recap-opencode", `run failed:`, message);
    return { error: message };
  } finally {
    if (sessionToken) {
      try {
        await params.sessionDeps.clearSessionToken(sessionToken);
      } catch {
        /* ignore */
      }
    }
  }
}
