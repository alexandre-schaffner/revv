// ── Prose-voice advisory ─────────────────────────────────────────────────────
// `PROSE_VOICE_CONTRACT` and the banned-opener list are the most-repeated,
// least-enforced instructions in the walkthrough prompt; voice is a judgment,
// not something a word budget can check.
//
// Runs behind the agent, like the issue gate, so it doesn't put a round trip on
// every `add_diff_step` call (Phase B's hot path). Samples only the first few
// markdown blocks, to catch a habit while there's still a run left to fix it,
// and hands the verdict back on a later tool result rather than rejecting
// anything.
//
// Advisory, never a gate: nothing downstream reads it, and `complete_walkthrough`
// doesn't consult it.

import { noul } from "@typesafe-ai/sdk";
import { Effect } from "effect";
import { JevService } from "../../services/Jev";
import { SettingsService } from "../../services/Settings";
import { optionalJev } from "./optional";

export const PROSE_VOICE_TIMEOUT_MS = 12_000;

/** Markdown blocks sampled per walkthrough. Enough to tell a habit from a one-off, early enough to leave most of Phase B to act on it. */
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

/** Judges one markdown block's voice. Returns `null` when off/unavailable, `[]` when clean; the caller surfaces nothing either way. */
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
          preamble: noul(FAULTS.preamble),
          hedging: noul(FAULTS.hedging),
          padding: noul(FAULTS.padding),
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
// A judgment landing between two tool calls has nowhere to go, so it waits here
// and rides out on the next `add_diff_step` result. Ephemeral and lossy: losing
// an advisory costs a sentence of feedback, so it has no business in SQLite.

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

/** Drains the mailbox as agent-facing text, or `null` if empty. Drains rather than peeks: repeating the same advice on every block would read as nagging and train the agent to skim result text. */
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
