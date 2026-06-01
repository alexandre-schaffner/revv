// ── Job failure verdict ────────────────────────────────────────────────────
//
// Shared cause analysis for the two durable job orchestrators (walkthrough,
// recap). Answers a single question: when a job fiber's body fails, should the
// row be left `'generating'` for resume-on-boot to retry, or transitioned to
// `'error'`?
//
// The rule encodes CLAUDE.md invariant #1's split between an unattended
// process-shutdown interrupt (resume-worthy) and a user-driven cancel or a
// genuine failure (terminal):
//
//   • interrupt-only AND not user-cancelled  → "leave-for-resume"
//     A bare `Fiber.interrupt` with no accompanying user intent is what a
//     `kill -9` / graceful-shutdown looks like; the row stays generating so
//     `resumePending` can re-launch it (bounded by the resume-attempt budget).
//   • everything else                        → "error"
//     A real defect/failure, OR an interrupt that the user explicitly asked
//     for (Stop), both terminate the row.
//
// The helper returns ONLY the verdict — each orchestrator keeps its own
// logging, `setStatus`, and event-emit on the result (their messages, scopes,
// and broadcast shapes legitimately differ).

import { Cause } from "effect";

export type JobFailureVerdict = "leave-for-resume" | "error";

export const analyzeJobFailure = <E>(
  cause: Cause.Cause<E>,
  opts: { readonly cancelledByUser: boolean },
): JobFailureVerdict =>
  Cause.isInterruptedOnly(cause) && !opts.cancelledByUser ? "leave-for-resume" : "error";
