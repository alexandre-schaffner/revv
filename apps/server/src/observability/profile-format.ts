import type { SamplingProfileStackTraces } from "bun:jsc";

/** Pyroscope folded stacks are outermost-first. JSC samples are leaf-first.
 * Include source locations and sanitize delimiters; never send source text. */
export function foldedStacks(profile: SamplingProfileStackTraces): string {
  const counts = new Map<string, number>();
  const clean = (value: string) => value.replace(/[;\r\n\t]/g, "_").slice(0, 512);
  for (const sample of profile.traces) {
    const stack = sample.frames
      .slice(0, 128)
      .map((frame) => {
        const location = frame.sourceURL ? ` (${frame.sourceURL}:${frame.line})` : "";
        return clean(`${frame.name || "(anonymous)"}${location}`);
      })
      .reverse()
      .join(";");
    if (stack) counts.set(stack, (counts.get(stack) ?? 0) + 1);
  }
  return [...counts].map(([stack, count]) => `${stack} ${count}`).join("\n");
}
