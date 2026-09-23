import { Effect } from "effect";
import { debug } from "../../logger";

/** Collapse an optional Jev judgment into `null`, with one consistent log. */
export function optionalJev<A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | null, never, R> {
  return effect.pipe(
    Effect.match({
      onFailure: (error) => {
        debug("jev", `${label} unavailable (${String(error)}) — using agent judgment`);
        return null;
      },
      onSuccess: (value) => value,
    }),
  );
}
