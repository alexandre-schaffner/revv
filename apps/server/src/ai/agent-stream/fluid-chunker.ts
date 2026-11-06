import type { NormalizedAgentEvent } from "./normalized-events";

/**
 * Tuned for a typewriter cadence: a paragraph-sized delta doesn't dump in one
 * go, and the chat UI isn't flooded with single-character updates.
 */
const FLUID_DEFAULT_CHUNK_LEN = 12;

/**
 * ACP agents don't all stream at the same granularity — some hand back a whole
 * content block (several paragraphs) as one `agent_message_chunk`, others pace
 * per token but flush in bursts — so long text/reasoning deltas are re-split
 * to give the chat bubble a uniform cadence.
 *
 * A stateful `emit` (the chat driver's `hasEmittedText` / `lastWasNonText`
 * separator tracking) is updated by the first sub-chunk, so later sub-chunks
 * correctly skip the separator.
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
    for (const chunk of splitForFluidStream(ev.data, targetLen)) {
      emit({ kind: ev.kind, data: chunk });
    }
  };
}

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
      const ch = text[j];
      if (ch !== undefined && boundary.test(ch)) {
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
