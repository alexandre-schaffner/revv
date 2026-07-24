import type { WalkthroughLifecyclePhase, WalkthroughStreamEvent } from "@revv/shared";
import {
  WALKTHROUGH_FIRST_EVENT_TIMEOUT_MS,
  WALKTHROUGH_INACTIVITY_TIMEOUT_MS,
} from "../../constants";
import { debug } from "../../logger";
import { ZERO_TOKEN_USAGE } from "../agent-stream/token-usage";

// ── Phase synthesis messages ────────────────────────────────────────────────
//
// Cross-agent normalization layer wrapping each provider's generator:
//   - inactivity + first-event timeouts,
//   - synthesizes a terminal `done` / `error` if the inner generator ends
//     without one,
//   - optional phase synthesis for providers that don't emit their own.
//
// Liveness is enforced by two timers only: a first-event timeout and an
// inactivity timeout that ANY event resets — content, phase heartbeat, or
// reasoning. A model that reads files for a long time before it produces output
// is legitimate, so there is no separate exploration-stall gate; the hard
// `withAgentTurn` wall (CLI_WALKTHROUGH_TIMEOUT_MS) is the backstop for an agent
// that emits heartbeats forever without finishing.

const PHASE_MESSAGES = {
  exploration: {
    phase: "exploring" as const,
    message: "Reading files and understanding changes...",
  },
  summary: { phase: "analyzing" as const, message: "Forming assessment and risk analysis..." },
  block: { phase: "writing" as const, message: "Building walkthrough..." },
  rating: { phase: "rating" as const, message: "Scoring the PR across 9 axes..." },
} satisfies Record<string, { phase: WalkthroughLifecyclePhase; message: string }>;

// ── Guard wrapper ───────────────────────────────────────────────────────────

/**
 * Wraps a walkthrough async generator to enforce consistent behavior
 * regardless of which AI provider produced it.
 *
 * Guarantees:
 * - Always yields either a `done` or `error` event before returning.
 * - Aborts with an error if no events arrive for `inactivityTimeoutMs`.
 * - Synthesizes `phase` events from observed event types (when enabled).
 * - Calls `inner.return()` on cleanup to trigger provider-side teardown.
 */
export function guardWalkthroughStream(
  inner: AsyncGenerator<WalkthroughStreamEvent>,
  options?: {
    inactivityTimeoutMs?: number;
    synthesizePhases?: boolean;
    label?: string;
    firstEventTimeoutMs?: number;
  },
): AsyncGenerator<WalkthroughStreamEvent> {
  const inactivityMs = options?.inactivityTimeoutMs ?? WALKTHROUGH_INACTIVITY_TIMEOUT_MS;
  const synthesize = options?.synthesizePhases ?? true;
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

    // Track which phases we've synthesized so we don't repeat
    let emittedExploringPhase = false;
    let emittedAnalyzingPhase = false;
    let emittedWritingPhase = false;
    let emittedRatingPhase = false;

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

        // Synthesize phase events for providers that don't emit them
        if (synthesize) {
          if (event.type === "exploration" && !emittedExploringPhase) {
            emittedExploringPhase = true;
            yield { type: "phase" as const, data: PHASE_MESSAGES.exploration };
          }
          if (event.type === "summary" && !emittedAnalyzingPhase) {
            emittedAnalyzingPhase = true;
            yield { type: "phase" as const, data: PHASE_MESSAGES.summary };
          }
          if ((event.type === "semantic-step" || event.type === "block") && !emittedWritingPhase) {
            emittedWritingPhase = true;
            yield { type: "phase" as const, data: PHASE_MESSAGES.block };
          }
          if (event.type === "rating" && !emittedRatingPhase) {
            emittedRatingPhase = true;
            yield { type: "phase" as const, data: PHASE_MESSAGES.rating };
          }
        }

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
