// ── Abort + timeout harness ─────────────────────────────────────────────────

import { debug } from "../../logger";

// ── Turn deadlines ──

/**
 * Absolute ceiling for a CLI-driven walkthrough or recap turn. A backstop for
 * an agent that produces events forever without finishing — NOT a budget. A
 * large PR legitimately takes tens of minutes to review, and killing a
 * still-working agent throws away real work, so liveness is enforced by
 * AGENT_IDLE_TIMEOUT_MS instead and this is set far above any healthy run.
 */
export const CLI_WALKTHROUGH_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

/**
 * Idle deadline for walkthrough/recap turns: abort only when the agent shows NO
 * sign of life — no ACP session update, no MCP content write — for this long.
 * Rearmed by genuine agent activity only (unlike the stream guard's inactivity
 * timer, which the synthetic phase heartbeat also resets), so a slow `Bash`
 * call or a long thinking gap is tolerated while a dead daemon is still caught
 * within minutes. See `ActivityBeacon`.
 */
export const AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Absolute ceiling for a chat turn. Chat turns can legitimately run much longer
 * than walkthroughs — a single "Request Changes" prompt may ask the agent
 * to address every walkthrough issue with separate commits, each commit
 * involving multiple Read/Edit/Bash tool calls. Mirror the opencode TUI's
 * permissive behaviour: only abort on truly stuck sessions, not on length.
 */
export const CLI_CHAT_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Idle deadline for chat turns. Longer than AGENT_IDLE_TIMEOUT_MS because chat
 * agents shell out to test suites, builds and installs that emit nothing until
 * they exit — the tool call is one ACP event, then silence until the result.
 */
export const CHAT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

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
