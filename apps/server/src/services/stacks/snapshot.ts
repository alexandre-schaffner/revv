// ── Persisted stack snapshots ───────────────────────────────────────────────
//
// `walkthroughs.stack_context` holds the stack a walkthrough's agent saw. The
// column is written by the orchestrator, but it's still text off disk: a row
// that doesn't parse reads as "no stack", never as a crash mid-job.

import type { WalkthroughStackSnapshot } from "@revv/shared";

function isLayer(v: unknown): v is WalkthroughStackSnapshot["layers"][number] {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.position === "number" &&
    typeof l.number === "number" &&
    typeof l.title === "string" &&
    (typeof l.headSha === "string" || l.headSha === null) &&
    typeof l.baseRef === "string" &&
    typeof l.status === "string"
  );
}

export function parseStackSnapshot(json: string | null): WalkthroughStackSnapshot | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const s = v as Record<string, unknown>;
    if (
      typeof s.number !== "number" ||
      typeof s.baseRefName !== "string" ||
      typeof s.position !== "number" ||
      typeof s.capturedAt !== "string" ||
      !Array.isArray(s.layers) ||
      !s.layers.every(isLayer)
    ) {
      return null;
    }
    return v as WalkthroughStackSnapshot;
  } catch {
    return null;
  }
}
