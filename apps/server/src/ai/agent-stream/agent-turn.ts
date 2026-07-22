// ── Abort + hard-timeout harness ────────────────────────────────────────────

import { debug } from "../../logger";

export interface AgentTurnContext {
  /**
   * Composed signal: aborts on external cancel OR hard timeout. Pass this
   * to anything that should die when the turn dies (HTTP fetches, the
   * Claude SDK's `query()`, etc.).
   */
  readonly signal: AbortSignal;
  /** True after the hard-timeout fired. */
  readonly wasTimeout: () => boolean;
  /** True after the external `abortController` fired. */
  readonly wasCancelled: () => boolean;
}

export interface WithAgentTurnOptions<T> {
  readonly externalAbort?: AbortController | undefined;
  readonly hardTimeoutMs: number;
  readonly jobStarted: () => Promise<void>;
  readonly jobEnded: () => Promise<void>;
  /**
   * Called once when the external abort OR the hard timeout fires. Both
   * opencode providers use this to call `client.session.abort({ path: { id: sessionId } })`
   * so the daemon stops the model. May be a no-op for callers without a
   * remote session to cancel.
   */
  readonly abortSession?: () => Promise<void>;
  /**
   * Synchronously fired when the external abort signal trips. Used by the
   * walkthrough opencode driver to flip a `cancelled` flag the activity
   * notifier (registered before `withAgentTurn`) reads to suppress late
   * events. Distinct from `abortSession` (async; cancels the remote
   * session) and from `ctx.wasCancelled()` (read-only; only callable
   * inside `run`).
   */
  readonly onCancel?: () => void;
  /** Synchronously fired when the hard-timeout trips. */
  readonly onTimeout?: () => void;
  readonly run: (ctx: AgentTurnContext) => Promise<T>;
  /** For debug logs ("chat-opencode", "walkthrough-opencode-mcp", …). */
  readonly debugLabel: string;
}

/**
 * Wrap a turn's run-body with the abort + hard-timeout + refcount envelope.
 *
 *   1. `jobStarted()` is awaited before `run` is called (bumps the daemon's
 *      active-job refcount, etc.).
 *   2. A hard-timeout fires after `hardTimeoutMs`; flips `wasTimeout()` to
 *      true, triggers `abortSession()`, and propagates an AbortError through
 *      the composed signal.
 *   3. An external `abortController.signal.abort()` flips `wasCancelled()`
 *      to true, triggers `abortSession()`, and propagates through the
 *      composed signal.
 *   4. `jobEnded()` is awaited in the `finally`, regardless of outcome.
 *
 * Errors thrown by `run` propagate to the caller. Callers compose their own
 * error chip from `wasTimeout()` / `wasCancelled()` after catching.
 */
export async function withAgentTurn<T>(opts: WithAgentTurnOptions<T>): Promise<T> {
  const composed = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let abortSessionFired = false;

  const fireAbortSession = (): void => {
    if (abortSessionFired) return;
    abortSessionFired = true;
    if (!opts.abortSession) return;
    void opts.abortSession().catch((err) => {
      debug(
        opts.debugLabel,
        "abortSession failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  };

  const timeoutId = setTimeout(() => {
    timedOut = true;
    debug(opts.debugLabel, "hard timeout — aborting session");
    opts.onTimeout?.();
    fireAbortSession();
    try {
      composed.abort(
        new Error(`Agent turn timed out after ${Math.round(opts.hardTimeoutMs / 60_000)} minutes`),
      );
    } catch {
      /* already aborted */
    }
  }, opts.hardTimeoutMs);

  const externalAbort = opts.externalAbort;
  const onExternalAbort = (): void => {
    cancelled = true;
    opts.onCancel?.();
    fireAbortSession();
    try {
      composed.abort(externalAbort?.signal.reason);
    } catch {
      /* already aborted */
    }
  };

  if (externalAbort) {
    if (externalAbort.signal.aborted) {
      onExternalAbort();
    } else {
      externalAbort.signal.addEventListener("abort", onExternalAbort, {
        once: true,
      });
    }
  }

  await opts.jobStarted();

  try {
    const ctx: AgentTurnContext = {
      signal: composed.signal,
      wasTimeout: () => timedOut,
      wasCancelled: () => cancelled,
    };
    const runPromise = opts.run(ctx);
    let abortSettled = false;
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        abortSettled = true;
        const reason = composed.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error(
                timedOut
                  ? `Agent turn timed out after ${Math.round(opts.hardTimeoutMs / 60_000)} minutes`
                  : cancelled
                    ? "Agent turn cancelled"
                    : "Agent turn aborted",
              ),
        );
      };
      if (composed.signal.aborted) {
        onAbort();
        return;
      }
      composed.signal.addEventListener("abort", onAbort, { once: true });
      runPromise.then(
        () => composed.signal.removeEventListener("abort", onAbort),
        () => composed.signal.removeEventListener("abort", onAbort),
      );
    });

    void runPromise.catch((err) => {
      if (!abortSettled) return;
      debug(
        opts.debugLabel,
        "run settled after abort:",
        err instanceof Error ? err.message : String(err),
      );
    });

    return await Promise.race([runPromise, abortPromise]);
  } finally {
    clearTimeout(timeoutId);
    if (externalAbort) {
      externalAbort.signal.removeEventListener("abort", onExternalAbort);
    }
    try {
      await opts.jobEnded();
    } catch {
      /* swallow — refcount drift logged elsewhere */
    }
  }
}
