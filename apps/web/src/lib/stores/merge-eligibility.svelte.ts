import type { CiRollupState, MergeEligibility, PrConversation, ReviewDecision } from "@revv/shared";
import { isMergeStateSettling } from "$lib/utils/merge-blocker";
import { RequestState } from "./_types";
import { getMergeEligibility } from "./prs.svelte";

/** Everything a mergeability answer depends on that Revv observes. Equal questions share one answer. */
export interface MergeQuestion {
  readonly prId: string;
  readonly headSha: string | null;
  readonly reviewDecision: ReviewDecision | null;
  readonly ciState: CiRollupState | null;
}

interface Entry {
  readonly question: MergeQuestion;
  readonly request: RequestState<MergeEligibility>;
  readonly askedAt: number;
}

const RETRY_MS = 3_000;
const MAX_RETRIES = 4;
const FRESH_FOR_MS = 15_000;

let entries = $state(new Map<string, Entry>());

const generations = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setEntry(prId: string, entry: Entry): void {
  entries.set(prId, entry);
  entries = new Map(entries);
}

function updateEntry(prId: string, update: (entry: Entry) => Entry): void {
  const entry = entries.get(prId);
  if (entry) setEntry(prId, update(entry));
}

/**
 * The question for a PR as Revv currently sees it. Everyone who asks about
 * the same PR builds it here, so equal views share one GitHub call.
 */
export function mergeQuestionFor(
  prId: string,
  headSha: string | null,
  conversation: PrConversation | null,
): MergeQuestion {
  return {
    prId,
    headSha,
    reviewDecision: conversation?.reviewDecision ?? null,
    ciState: conversation?.ci?.state ?? null,
  };
}

function sameQuestion(a: MergeQuestion, b: MergeQuestion): boolean {
  return (
    a.prId === b.prId &&
    a.headSha === b.headSha &&
    a.reviewDecision === b.reviewDecision &&
    a.ciState === b.ciState
  );
}

/** The PR's latest answer; null without a question. */
export function getMergeAnswer(question: MergeQuestion | null): MergeEligibility | null {
  const request = question ? entries.get(question.prId)?.request : undefined;
  return request?.status === "ok" ? request.data : null;
}

/**
 * Asks GitHub unless an equal question is in flight, retrying, or answered
 * under `FRESH_FOR_MS` ago. The PR's last answer stays up meanwhile.
 */
export function askMergeEligibility(question: MergeQuestion): void {
  const { prId } = question;
  const entry = entries.get(prId);
  if (
    entry &&
    sameQuestion(entry.question, question) &&
    (entry.request.status === "loading" ||
      retryTimers.has(prId) ||
      Date.now() - entry.askedAt < FRESH_FOR_MS)
  ) {
    return;
  }
  clearTimeout(retryTimers.get(prId));
  retryTimers.delete(prId);
  const generation = (generations.get(prId) ?? 0) + 1;
  generations.set(prId, generation);
  setEntry(prId, {
    question,
    request: entry?.request.status === "ok" ? entry.request : RequestState.loading(),
    askedAt: Date.now(),
  });
  ask(prId, generation, MAX_RETRIES);
}

function ask(prId: string, generation: number, retriesLeft: number): void {
  void getMergeEligibility(prId).then((eligibility) => {
    if (generations.get(prId) !== generation) return;
    updateEntry(prId, (entry) => ({
      ...entry,
      request: eligibility
        ? RequestState.ok(eligibility)
        : RequestState.error("Couldn't check whether this can be merged"),
      askedAt: Date.now(),
    }));
    if (eligibility && isMergeStateSettling(eligibility.mergeStateStatus) && retriesLeft > 0) {
      retryTimers.set(
        prId,
        setTimeout(() => {
          retryTimers.delete(prId);
          if (generations.get(prId) === generation) ask(prId, generation, retriesLeft - 1);
        }, RETRY_MS),
      );
    }
  });
}
