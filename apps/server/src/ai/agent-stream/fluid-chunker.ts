// ── Fluid stream chunker ────────────────────────────────────────────────────

import type { NormalizedAgentEvent } from "./normalized-events";

/**
 * Target chars per emitted text/reasoning chunk before the fluid splitter
 * kicks in. Tuned to feel like a natural typewriter cadence: small enough
 * that a paragraph-sized delta doesn't dump in one go, large enough that
 * we're not flooding the chat UI with single-character updates.
 */
const FLUID_DEFAULT_CHUNK_LEN = 12;

/**
 * Wrap an `emit` function so `text-delta` and `reasoning-delta` events
 * longer than `targetChunkLen` are split into smaller word-boundary-aligned
 * chunks. All other event kinds pass through untouched, and deltas already
 * shorter than the target emit as-is (no overhead).
 *
 * Why this exists: provider drivers don't all stream at the same
 * granularity. The Claude SDK without `includePartialMessages: true` hands
 * back each content block as a single chunk — potentially several
 * paragraphs in one event. Opencode's daemon usually paces deltas per
 * model-token, but bursty event flushes can still pile up. Both paths
 * route through `fluidEmit` so the chat bubble sees a uniform, typewriter-
 * like cadence regardless of upstream behaviour.
 *
 * Splits prefer the next whitespace/punctuation within a 2x lookahead so
 * words aren't sliced mid-letter. Long unbroken runs (URLs, identifier
 * chains) hard-cut at `2 * targetChunkLen` rather than emit one long
 * chunk. When the wrapped `emit` carries state (e.g. the chat drivers'
 * `hasEmittedText` / `lastWasNonText` separator tracking), that state is
 * updated by the first sub-chunk only — subsequent sub-chunks see the
 * post-first state and skip the separator, which is exactly what we want.
 */
export function fluidEmit(
  emit: (ev: NormalizedAgentEvent) => void,
  opts?: { targetChunkLen?: number },
): (ev: NormalizedAgentEvent) => void {
  const targetLen = Math.max(1, opts?.targetChunkLen ?? FLUID_DEFAULT_CHUNK_LEN);
  return (ev: NormalizedAgentEvent): void => {
    if (ev.kind !== "text-delta" && ev.kind !== "reasoning-delta") {
      emit(ev);
      return;
    }
    if (ev.data.length <= targetLen) {
      emit(ev);
      return;
    }
    const partIdField = ev.partId !== undefined ? { partId: ev.partId } : {};
    for (const chunk of splitForFluidStream(ev.data, targetLen)) {
      if (ev.kind === "text-delta") {
        emit({ kind: "text-delta", data: chunk, ...partIdField });
      } else {
        emit({ kind: "reasoning-delta", data: chunk, ...partIdField });
      }
    }
  };
}

/**
 * Split `text` into chunks targeting `targetLen` chars, snapping to the
 * next whitespace/punctuation boundary within a 2x lookahead window when
 * one exists. Falls back to a hard cut at `2 * targetLen` for long
 * unbroken runs (URLs, identifier chains) so a worst-case input still
 * emits as multiple chunks. The trailing remainder is always emitted as-is.
 */
export function splitForFluidStream(text: string, targetLen: number): string[] {
  const out: string[] = [];
  const boundary = /[\s.,;:!?\-—)\]}>"']/;
  let i = 0;
  while (i < text.length) {
    const remaining = text.length - i;
    if (remaining <= targetLen) {
      out.push(text.slice(i));
      return out;
    }
    let end = i + targetLen;
    const stop = Math.min(i + targetLen * 2, text.length);
    let foundBoundary = false;
    for (let j = end; j < stop; j += 1) {
      if (boundary.test(text[j]!)) {
        // Include the boundary char so the next chunk starts on a
        // fresh word — `"hello, "` then `"world"` reads cleanly.
        end = j + 1;
        foundBoundary = true;
        break;
      }
    }
    if (!foundBoundary) end = stop;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
