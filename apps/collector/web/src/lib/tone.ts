// Severity is never communicated by colour alone (DESIGN a11y contract): each
// tone pairs a colour token with a distinct phosphor icon and a label.

import { CheckCircle, Circle, Warning, WarningOctagon } from "phosphor-svelte";

export type Tone = "ok" | "warn" | "bad" | "neutral";

export const toneColor: Record<Tone, string> = {
  ok: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--danger)",
  neutral: "var(--ink-muted)",
};

export const toneIcon: Record<Tone, typeof CheckCircle> = {
  ok: CheckCircle,
  warn: Warning,
  bad: WarningOctagon,
  neutral: Circle,
};

/** Error-rate → tone. >5% reads as bad, >0.5% as a concern, else healthy. */
export function errorRateTone(rate: number | null): Tone {
  if (rate == null) return "neutral";
  if (rate > 0.05) return "bad";
  if (rate > 0.005) return "warn";
  return "ok";
}

/** Map an HTTP status to a tone for the badge in span lists. */
export function httpTone(status: number | null): Tone {
  if (status == null) return "neutral";
  if (status >= 500) return "bad";
  if (status >= 400) return "warn";
  return "ok";
}
