import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { JevUnavailable } from "../../domain/errors";
import { JevService } from "../../services/Jev";
import { adjudicateContinuation, STOP_CONFIDENCE_FLOOR } from "./continuation";
import type { ContinuationInput } from "./state";

const STATE: ContinuationInput = {
  autoContinuations: 1,
  maxAutoContinuations: 2,
  lastCompletedPhase: "B",
  phaseAtLastContinuation: "B",
  counts: { diff_steps: 4, rated_axes: 0 },
  countsAtLastContinuation: { diff_steps: 4, rated_axes: 0 },
  terminalReason: "generator-ended",
  elapsedMs: 120_000,
  totalTokens: 90_000,
};

/** A JevService that answers with fixed choices, and records whether it ran. */
function stubJev(answers: Record<string, { choice: string; confidence: number }>) {
  const calls = { count: 0 };
  const layer = Layer.succeed(JevService, {
    // `ask` is generic over the question map, which a literal can't express.
    ask: (() => {
      calls.count += 1;
      return Effect.succeed({
        model: "stub",
        usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(
          Object.entries(answers).map(([k, v]) => [
            k,
            { type: "choice", choice: v.choice, confidence: v.confidence, probabilities: {} },
          ]),
        ),
      });
    }) as never,
    isAvailable: () => Effect.succeed(true),
    testConnection: () => Effect.succeed({ model: "stub", latencyMs: 0 }),
  });
  return { layer, calls };
}

/** A JevService whose every call fails, to prove failures mean `proceed`. */
const failingJev = Layer.succeed(JevService, {
  ask: (() => Effect.fail(new JevUnavailable({ reason: "timeout" }))) as never,
  isAvailable: () => Effect.succeed(false),
  testConnection: () => Effect.fail(new JevUnavailable({ reason: "unconfigured" })),
});

describe("adjudicateContinuation", () => {
  it("proceeds without asking when the toggle is off", async () => {
    const { layer, calls } = stubJev({
      progress_since_last: { choice: "none", confidence: 1 },
      will_next_turn_finish: { choice: "unlikely", confidence: 1 },
    });
    const verdict = await Effect.runPromise(
      adjudicateContinuation({ ...STATE, enabled: false }).pipe(Effect.provide(layer)),
    );
    expect(verdict.kind).toBe("proceed");
    expect(calls.count).toBe(0);
  });

  it("stops only when progress is none AND the next turn is unlikely to finish", async () => {
    const { layer } = stubJev({
      progress_since_last: { choice: "none", confidence: 0.95 },
      will_next_turn_finish: { choice: "unlikely", confidence: 0.95 },
    });
    const verdict = await Effect.runPromise(
      adjudicateContinuation({ ...STATE, enabled: true }).pipe(Effect.provide(layer)),
    );
    expect(verdict.kind).toBe("stop-doomed");
  });

  it("proceeds when either answer disagrees", async () => {
    for (const answers of [
      {
        progress_since_last: { choice: "marginal", confidence: 0.95 },
        will_next_turn_finish: { choice: "unlikely", confidence: 0.95 },
      },
      {
        progress_since_last: { choice: "none", confidence: 0.95 },
        will_next_turn_finish: { choice: "likely", confidence: 0.95 },
      },
    ]) {
      const { layer } = stubJev(answers);
      const verdict = await Effect.runPromise(
        adjudicateContinuation({ ...STATE, enabled: true }).pipe(Effect.provide(layer)),
      );
      expect(verdict.kind).toBe("proceed");
    }
  });

  it("proceeds when either answer is below the confidence floor", async () => {
    const { layer } = stubJev({
      progress_since_last: { choice: "none", confidence: STOP_CONFIDENCE_FLOOR - 0.01 },
      will_next_turn_finish: { choice: "unlikely", confidence: 0.99 },
    });
    const verdict = await Effect.runPromise(
      adjudicateContinuation({ ...STATE, enabled: true }).pipe(Effect.provide(layer)),
    );
    expect(verdict.kind).toBe("proceed");
  });

  it("proceeds when the call fails — never costs a walkthrough", async () => {
    const verdict = await Effect.runPromise(
      adjudicateContinuation({ ...STATE, enabled: true }).pipe(Effect.provide(failingJev)),
    );
    expect(verdict.kind).toBe("proceed");
  });
});
