// ── Prose-voice advisory ─────────────────────────────────────────────────────
//
// `PROSE_VOICE_CONTRACT` and the banned-opener list are the most-repeated
// instructions in the walkthrough prompt and the only ones nothing enforces.
// Word budgets are code-checkable and don't need a model; voice is a judgment.
//
// The shape here is the one thing that makes it viable. A blocking check on
// `add_diff_step` would put a round trip on *every* block — Phase B's hot
// path — and roughly double its wall-clock. So:
//
//   • it runs **behind** the agent, like the issue gate;
//   • it samples only the **first few** markdown blocks, because the point is
//     to catch a voice the run has settled into while there is still a run
//     left to correct;
//   • the verdict is handed back on a **later tool result** rather than
//     rejecting anything. Prose already written is not worth a rewrite; the
//     next eight blocks are worth getting right.
//
// Advisory, never a gate. Nothing downstream reads it, `complete_walkthrough`
// doesn't consult it, and a run that ignores it completes exactly as before.

import { Effect } from "effect";
import { JevService } from "../../services/Jev";
import { SettingsService } from "../../services/Settings";
import { optionalJev } from "./optional";
import { noulQuestion } from "./questions";

export const PROSE_VOICE_TIMEOUT_MS = 12_000;

/**
 * How many markdown blocks get sampled per walkthrough.
 *
 * Three. Enough to tell a habit from a one-off, few enough that the cost is
 * noise, and early enough that the advice still has most of Phase B to act
 * on. Sampling more would mostly re-confirm the first answer.
 */
export const PROSE_SAMPLE_SIZE = 3;

/** Probability above which a failing habit is worth telling the agent about. */
export const PROSE_FAULT_FLOOR = 0.6;

const FAULTS = {
  preamble:
    "The text opens by announcing what it is about to do, or by restating the chapter title, instead of opening on the point.",
  hedging:
    "The text hedges: 'it seems', 'may possibly', 'one could argue', concessive openers like 'While X is generally fine, ...' that delay the actual claim.",
  padding:
    "The text says in several sentences what one sentence would carry — restating the diff in prose rather than telling the reader something the diff does not.",
} as const satisfies Record<string, string>;

const FAULT_KEYS = ["preamble", "hedging", "padding"] as const;

const FAULT_ADVICE: Record<keyof typeof FAULTS, string> = {
  preamble: "you are opening on preamble — cut the first sentence and start on the point",
  hedging: "you are hedging — state the claim, then the evidence, and drop the concessive openers",
  padding: "you are padding — say it once, and only if the diff does not already say it",
};

/**
 * Judge one markdown block's voice.
 *
 * Returns `null` when the hook is off or unavailable, and an empty array when
 * the prose is clean — the caller surfaces nothing in both cases.
 */
export function judgeProse(
  markdown: string,
  chapterTitle: string,
): Effect.Effect<readonly string[] | null, never, JevService | SettingsService> {
  return Effect.gen(function* () {
    const settingsSvc = yield* SettingsService;
    const settings = yield* settingsSvc.getSettings().pipe(Effect.orElseSucceed(() => null));
    if (settings?.jev.proseVoice !== true) return null;
    // Too short to have a voice — a one-line block is all point, by construction.
    if (markdown.trim().length < 200) return [];

    const jev = yield* JevService;
    const result = yield* optionalJev(
      "prose voice",
      jev.ask({
        label: "prose",
        timeoutMs: PROSE_VOICE_TIMEOUT_MS,
        state: {
          chapter: chapterTitle,
          block: markdown.slice(0, 8_000),
          voice:
            "This is a block of a code-review walkthrough. It is meant to open on the point, lead with the claim and follow with the evidence, and tell the reader something the diff does not already say.",
        },
        questions: {
          preamble: noulQuestion(FAULTS.preamble),
          hedging: noulQuestion(FAULTS.hedging),
          padding: noulQuestion(FAULTS.padding),
        },
      }),
    );

    if (result === null) return null;

    const answers = result.answers;
    return FAULT_KEYS.filter((key) => {
      const answer: unknown = answers[key];
      if (answer === null || typeof answer !== "object" || !("noul" in answer)) return false;
      return typeof answer.noul === "number" && answer.noul >= PROSE_FAULT_FLOOR;
    }).map((key) => FAULT_ADVICE[key]);
  });
}

// ── Per-walkthrough advisory mailbox ─────────────────────────────────────────
//
// A judgment that lands between two tool calls has nowhere to go: the call it
// was about has already returned. It waits here and rides out on the next
// `add_diff_step` result instead. Ephemeral and lossy on purpose — losing an
// advisory costs a sentence of feedback, so it has no business in SQLite.

const mailbox = new Map<string, string[]>();
const sampled = new Map<string, number>();

/** Whether this walkthrough still owes a sample. Claims the slot if so. */
export function claimProseSample(walkthroughId: string): boolean {
  const taken = sampled.get(walkthroughId) ?? 0;
  if (taken >= PROSE_SAMPLE_SIZE) return false;
  sampled.set(walkthroughId, taken + 1);
  return true;
}

export function postProseAdvice(walkthroughId: string, advice: readonly string[]): void {
  if (advice.length === 0) return;
  const box = mailbox.get(walkthroughId) ?? [];
  for (const line of advice) if (!box.includes(line)) box.push(line);
  mailbox.set(walkthroughId, box);
}

/**
 * Drain the mailbox as agent-facing text, or `null` when it's empty.
 *
 * Draining rather than peeking: the same advice repeated on every subsequent
 * block would read as nagging and train the agent to skim the result text,
 * which is where the required-next-step instructions live.
 */
export function takeProseAdvice(walkthroughId: string): string | null {
  const box = mailbox.get(walkthroughId);
  if (!box || box.length === 0) return null;
  mailbox.delete(walkthroughId);
  return `\n\nVOICE CHECK on an earlier block — ${box.join("; ")}. Don't rewrite what's already written; apply it from here on.`;
}

export function forgetProse(walkthroughId: string): void {
  mailbox.delete(walkthroughId);
  sampled.delete(walkthroughId);
}
