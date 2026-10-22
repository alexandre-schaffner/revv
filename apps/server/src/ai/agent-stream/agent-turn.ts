// ── Abort + timeout harness ─────────────────────────────────────────────────

import { debug } from "../../logger";

export interface AgentTurnContext {
  /**
   * Composed signal: aborts on external cancel OR either timeout. Pass this
   * to anything that should die when the turn dies (HTTP fetches, the
   * Claude SDK's `query()`, etc.).
   */
  readonly signal: AbortSignal;
  /** True after either timeout (idle deadline or absolute ceiling) fired. */
  readonly wasTimeout: () => boolean;
  /** True after the external `abortController` fired. */
  readonly wasCancelled: () => boolean;
}

/**
 * Liveness signal a driver pokes whenever the agent proves it is still working
 * — a decoded ACP `session/update`, an MCP content write, anything that could
 * only have come from a live agent. `withAgentTurn` subscribes to it and rearms
 * its idle deadline on every note.
 *
 * Deliberately NOT poked by synthetic heartbeats: those exist to keep the
 * stream guard (and the client) from declaring a stall, so letting them reset
 * the idle deadline would make it unfalsifiable.
 */
export interface ActivityBeacon {
  /** Record genuine agent activity. */
  readonly note: () => void;
  /** Subscribe to notes; returns an unsubscribe. Called by `withAgentTurn`. */
  readonly onNote: (listener: () => void) => () => void;
}

export function makeActivityBeacon(): ActivityBeacon {
  const listeners = new Set<() => void>();
  return {
    note: (): void => {
      for (const listener of listeners) listener();
    },
    onNote: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}

export interface WithAgentTurnOptions<T> {
  readonly externalAbort?: AbortController | undefined;
  /**
   * Absolute ceiling on the turn. A backstop, not a budget — an agent that is
   * demonstrably working should die of `idleTimeoutMs`, never of this.
   */
  readonly hardTimeoutMs: number;
  /**
   * Idle deadline: abort when `activity` records nothing for this long. Only
   * armed when an `activity` beacon is supplied — without one there is nothing
   * to rearm the timer and it would just be a second, shorter ceiling.
   */
  readonly idleTimeoutMs?: number;
  /** Liveness source for `idleTimeoutMs`. */
  readonly activity?: ActivityBeacon;
  readonly jobStarted: () => Promise<void>;
  readonly jobEnded: () => Promise<void>;
  /**
   * Called once when the external abort OR either timeout fires. Both
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
  /** Synchronously fired when either timeout trips. */
  readonly onTimeout?: () => void;
  readonly run: (ctx: AgentTurnContext) => Promise<T>;
  /** For debug logs ("chat-opencode", "walkthrough-opencode-mcp", …). */
  readonly debugLabel: string;
}

/**
 * Wrap a turn's run-body with the abort + timeout + refcount envelope.
 *
 *   1. `jobStarted()` is awaited before `run` is called (bumps the daemon's
 *      active-job refcount, etc.).
 *   2. Two timers can end the turn early, both flipping `wasTimeout()` to
 *      true, triggering `abortSession()`, and propagating through the composed
 *      signal: the idle deadline (`idleTimeoutMs`, rearmed by every
 *      `activity.note()`) and the absolute ceiling (`hardTimeoutMs`). The idle
 *      deadline is the one meant to fire in practice — a long turn is only a
 *      problem when the agent has stopped producing anything.
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

  /** "45 minutes" / "20 seconds" — keeps sub-minute values out of "0 minutes". */
  const humanize = (ms: number): string =>
    ms < 60_000 ? `${Math.round(ms / 1_000)} seconds` : `${Math.round(ms / 60_000)} minutes`;

  const fireTimeout = (message: string): void => {
    if (timedOut || cancelled || composed.signal.aborted) return;
    timedOut = true;
    debug(opts.debugLabel, `${message} — aborting session`);
    opts.onTimeout?.();
    fireAbortSession();
    try {
      composed.abort(new Error(message));
    } catch {
      /* already aborted */
    }
  };

  const ceilingId = setTimeout(
    () => fireTimeout(`Agent turn timed out after ${humanize(opts.hardTimeoutMs)}`),
    opts.hardTimeoutMs,
  );

  const beacon = opts.activity;
  const idleMs = opts.idleTimeoutMs;
  let idleId: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeActivity: (() => void) | undefined;
  if (beacon && idleMs !== undefined) {
    const rearmIdle = (): void => {
      clearTimeout(idleId);
      idleId = undefined;
      if (timedOut || cancelled || composed.signal.aborted) return;
      idleId = setTimeout(
        () => fireTimeout(`Agent stopped responding — no activity for ${humanize(idleMs)}`),
        idleMs,
      );
    };
    unsubscribeActivity = beacon.onNote(rearmIdle);
    rearmIdle();
  }

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
                  ? `Agent turn timed out after ${humanize(opts.hardTimeoutMs)}`
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
    clearTimeout(ceilingId);
    clearTimeout(idleId);
    unsubscribeActivity?.();
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
