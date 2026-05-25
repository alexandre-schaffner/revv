// Shared monotonic mutation counter. Bumped by every span/metric write site
// (tracer.recordSpan, metrics.recordCounter, metrics.recordHistogram). Read
// by the dev panel to fast-path refresh ticks when nothing has changed since
// the last compute pass — an idle app with the panel open does no work.

let mutationVersion = 0;

export function bumpVersion(): void {
  mutationVersion++;
}

export function getMutationVersion(): number {
  return mutationVersion;
}
