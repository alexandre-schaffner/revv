// ─── recap-opencode ──────────────────────────────────────────────────────────
//
// Opencode driver for project-recap generation. Mirrors the walkthrough's
// `mcp-walkthrough-opencode.ts` but radically simpler:
//
//   • Single-phase pipeline (one atomic `set_recap_overview` then
//     `complete_recap`), so no phase machine, no exploration emit, no
//     real-time stream guard.
//   • No SSE subscribers — recap status changes broadcast over WS only at
//     orchestrator completion, so we don't have to forward events from
//     `/global/event` to the UI.
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
//   4. Create an opencode session and post the recap prompt. The agent's
//      tool calls hit the HTTP MCP route directly; this driver only needs
//      to wait for the prompt to drain.
//   5. Aggregate token usage from `response.parts` step-finish frames +
//      the final `response.info.tokens` snapshot.
//   6. Clear the session token in `finally`.
//
// `withAgentTurn` wires the abort + 10-min hard timeout into the daemon's
// `client.session.abort` so a cancel/timeout tears down the model run.

import { serverEnv } from "../../config";
import { debug, logError } from "../../logger";
import { extractOpencodeErrorMessage, parseOpencodeModel, withAgentTurn } from "../agent-stream";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../prompts/recap";
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

        // ── 1. Issue session token + register MCP server ──────────
        sessionToken = await params.sessionDeps.issueSessionToken(params.ctx);
        const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/recap`;
        debug(
          "recap-opencode",
          `registering MCP ${RECAP_MCP_SERVER} → ${mcpUrl}`,
          "endpoint:",
          `${endpoint.hostname}:${endpoint.port}`,
        );
        const mcpResult = await client.mcp.add({
          directory: params.workingDir,
          name: RECAP_MCP_SERVER,
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
        const mcpEntry = mcpResult.data?.[RECAP_MCP_SERVER];
        if (!mcpEntry) {
          throw new Error(`opencode mcp.add returned no status for '${RECAP_MCP_SERVER}'`);
        }
        if (mcpEntry.status !== "connected") {
          throw new Error(
            `opencode mcp.add: '${RECAP_MCP_SERVER}' status=${mcpEntry.status}${
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
        sessionId = created.data.id;
        debug("recap-opencode", "created session:", sessionId);

        // ── 3. Post the prompt and drain ──────────────────────────
        const wireModel = parseOpencodeModel(params.modelUsed);
        const promptResult = await client.session.prompt(
          {
            sessionID: sessionId,
            directory: params.workingDir,
            parts: [{ type: "text", text: userMessage }],
            system: RECAP_SYSTEM_PROMPT,
            ...(wireModel !== undefined ? { model: wireModel } : {}),
          },
          { signal: ctx.signal, throwOnError: true },
        );

        const response = promptResult.data;

        // opencode returns 200 even when the agent loop fails (model not
        // found, provider auth missing). Surface the embedded error so
        // callers see a real failure instead of silent empty content.
        const errObj = response.info.error;
        if (errObj) {
          return { error: `opencode agent error: ${extractOpencodeErrorMessage(errObj)}` };
        }

        // ── 4. Aggregate token usage ──────────────────────────────
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
