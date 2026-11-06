import type { WalkthroughStreamEvent } from "@revv/shared";
import { debug } from "../../logger";
import { ZERO_TOKEN_USAGE } from "./walkthrough-token-usage";

/** Inactivity timeout for walkthrough stream guard (no events for this long = abort).
 *  Providers emit a periodic phase heartbeat every WALKTHROUGH_HEARTBEAT_MS, so this
 *  needs to comfortably exceed that interval. 4× heartbeat margin tolerates a missed
 *  beat without killing a still-running agent. Note the heartbeat is synthetic, so
 *  this timer cannot detect a stalled-but-connected agent — that is the turn
 *  runner's idle deadline (`JOB_TURN` in `ai/acp/run-turn.ts`). */
const WALKTHROUGH_INACTIVITY_TIMEOUT_MS = 180_000; // 180 seconds -- 3 min

/** Timeout for the first event from the AI provider — shorter since healthy providers emit immediately. */
const WALKTHROUGH_FIRST_EVENT_TIMEOUT_MS = 90_000; // 90 seconds

// Wraps the walkthrough driver's generator:
//   - inactivity + first-event timeouts,
//   - synthesizes a terminal `done` / `error` if the inner generator ends
//     without one.
//
// Liveness is enforced by two timers only: a first-event timeout and an
// inactivity timeout that ANY event resets — content, phase heartbeat, or
// reasoning. A model that reads files for a long time before it produces output
// is legitimate, so there is no separate exploration-stall gate. Because the
// phase heartbeat is synthetic, this layer cannot tell a working agent from a
// stalled-but-connected one; that is the turn runner's idle deadline, rearmed
// only by real agent activity, with its ceiling behind it (`JOB_TURN`).

// ── Guard wrapper ───────────────────────────────────────────────────────────

/**
 * Guarantees:
 * - Always yields either a `done` or `error` event before returning.
 * - Aborts with an error if no events arrive for `inactivityTimeoutMs`.
 * - Calls `inner.return()` on cleanup to trigger provider-side teardown.
 */
export function guardWalkthroughStream(
  inner: AsyncGenerator<WalkthroughStreamEvent>,
  options?: {
    inactivityTimeoutMs?: number;
    label?: string;
    firstEventTimeoutMs?: number;
  },
): AsyncGenerator<WalkthroughStreamEvent> {
  const inactivityMs = options?.inactivityTimeoutMs ?? WALKTHROUGH_INACTIVITY_TIMEOUT_MS;
  const label = options?.label ?? "guard";
  const firstEventMs = options?.firstEventTimeoutMs ?? WALKTHROUGH_FIRST_EVENT_TIMEOUT_MS;

  let isFirstEvent = true;

  return (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
    const iter = inner[Symbol.asyncIterator]();

    let sawSummary = false;
    let sawBlock = false;
    let sawRating = false;
    let sawDone = false;
    let sawError = false;

    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      while (true) {
        // Race the next event against the inactivity timeout
        const result = await Promise.race([
          iter.next().then((r) => ({ kind: "value" as const, ...r })),
          new Promise<{ kind: "timeout" }>((resolve) => {
            inactivityTimer = setTimeout(
              () => resolve({ kind: "timeout" }),
              isFirstEvent ? firstEventMs : inactivityMs,
            );
          }),
        ]);

        clearTimeout(inactivityTimer);
        inactivityTimer = undefined;

        if (result.kind === "timeout") {
          const timeoutDuration = isFirstEvent ? firstEventMs : inactivityMs;
          const timeoutMessage = isFirstEvent
            ? `AI provider failed to start within ${Math.round(firstEventMs / 1000)}s — the model may be unavailable or misconfigured.`
            : `Walkthrough generation stalled — no progress for ${Math.round(inactivityMs / 1000)}s. Try regenerating.`;
          debug(
            label,
            isFirstEvent ? "First-event timeout" : "Inactivity timeout",
            "—",
            timeoutDuration,
            "ms",
          );
          yield {
            type: "error" as const,
            data: {
              code: isFirstEvent ? "FirstEventTimeout" : "InactivityTimeout",
              message: timeoutMessage,
            },
          };
          return;
        }

        if (result.done) {
          // Inner generator ended — fall through to terminal event check
          break;
        }

        const event = result.value;
        isFirstEvent = false;

        // Track state
        if (event.type === "summary") sawSummary = true;
        if (event.type === "block") sawBlock = true;
        if (event.type === "rating") sawRating = true;
        if (event.type === "done") sawDone = true;
        if (event.type === "error") sawError = true;

        yield event;

        // Terminal event received — we're done
        if (event.type === "done" || event.type === "error") {
          return;
        }
      }

      // Inner generator ended without a terminal event.
      // Synthesize one based on what we observed.
      if (!sawDone && !sawError) {
        if (sawSummary && sawBlock) {
          // We have content but no explicit done — synthesize it. Ratings are
          // optional for this degraded path: a walkthrough with summary + blocks
          // is still useful even if the model never got around to the scorecard.
          debug(
            label,
            "Generator ended without done event, synthesizing done. sawRating:",
            sawRating,
          );
          yield {
            type: "done" as const,
            data: {
              walkthroughId: "",
              tokenUsage: ZERO_TOKEN_USAGE,
            },
          };
        } else {
          debug(label, "Generator ended without content or terminal event");
          yield {
            type: "error" as const,
            data: {
              code: "IncompleteWalkthrough",
              message:
                "Walkthrough generation completed without producing content. Try regenerating.",
            },
          };
        }
      }
    } catch (err) {
      // Unexpected error from the inner generator
      if (!sawDone && !sawError) {
        const message = err instanceof Error ? err.message : String(err);
        debug(label, "Unexpected error from inner generator:", message);
        yield {
          type: "error" as const,
          data: { code: "AiGenerationError", message },
        };
      }
    } finally {
      clearTimeout(inactivityTimer);
      // Signal the inner generator to clean up (kills subprocesses, etc.)
      try {
        await iter.return?.(undefined);
      } catch {
        /* inner cleanup failed — ignore */
      }
    }
  })();
}
