/**
 * Run `fn` once the frame in progress (and the one after it) has painted.
 *
 * For motion that starts on the heels of expensive work: a theme switch
 * restyles the whole app and a canvas repaints in the same frame, so a tween
 * started there spends its first ~100ms stalled and then jumps. Two frames
 * out, the heavy one has been drawn and the tween gets its whole duration.
 * Returns a cancel function.
 */
export function afterPaint(fn: () => void): () => void {
  let id = requestAnimationFrame(() => {
    id = requestAnimationFrame(fn);
  });
  return () => cancelAnimationFrame(id);
}
