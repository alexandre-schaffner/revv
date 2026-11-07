import type {
  ConversationActor,
  MergeEligibility,
  PrConversation,
  TimelineItem,
} from "@revv/shared";
import { mergeGate } from "./merge-blocker";
import { plural } from "./plural";

/**
 * The Conversation tab's overview: where a PR stands, read off the
 * conversation snapshot (and GitHub's mergeability answer when there is one)
 * in four questions a reviewer asks before reading anything else. Pure, so the
 * wording is pinned by tests rather than by eye.
 */

export type PulseTone = "good" | "bad" | "pending" | "neutral";

export type PulseStateKind = "open" | "draft" | "merged" | "closed";

export interface PulseCell {
  readonly tone: PulseTone;
  /** The answer, two or three words: "3 failing", "Approved". */
  readonly title: string;
  /** What backs it up, one short line. */
  readonly detail: string;
}

export interface PrPulse {
  readonly state: PulseStateKind;
  /** One sentence: what is happening on this PR right now. */
  readonly headline: string;
  /** Who did the thing the headline names, when one person did. */
  readonly actor: ConversationActor | null;
  /** When it happened, for a relative time beside the headline. */
  readonly at: string | null;
  readonly headlineTone: PulseTone;
  readonly checks: PulseCell;
  readonly reviews: PulseCell;
  readonly merge: PulseCell;
  readonly activity: PulseCell;
}

const STATE_WORD: Record<PulseStateKind, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export function pulseStateWord(state: PulseStateKind): string {
  return STATE_WORD[state];
}

function lastOf<K extends TimelineItem["kind"]>(
  timeline: readonly TimelineItem[],
  kind: K,
): Extract<TimelineItem, { kind: K }> | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item?.kind === kind) return item as Extract<TimelineItem, { kind: K }>;
  }
  return null;
}

function names(list: readonly string[], max = 2): string {
  if (list.length <= max) return list.join(" and ");
  return `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
}

function checksCell(c: PrConversation): PulseCell {
  if (c.ciAccess === "denied") {
    return { tone: "neutral", title: "Hidden", detail: "No permission to read checks" };
  }
  const checks = c.ci?.checks ?? [];
  if (checks.length === 0)
    return { tone: "neutral", title: "None", detail: "No checks on this head" };
  const count = (b: string) => checks.filter((x) => x.bucket === b).length;
  const fail = count("fail");
  const pending = count("pending");
  const pass = count("pass");
  const skip = count("skip");
  if (fail > 0) {
    const rest = [pending > 0 ? `${pending} running` : null, `${pass} passed`].filter(Boolean);
    return { tone: "bad", title: `${fail} failing`, detail: rest.join(" · ") };
  }
  if (pending > 0) {
    return { tone: "pending", title: `${pending} running`, detail: `${pass} passed so far` };
  }
  return {
    tone: "good",
    title: "All passed",
    detail: skip > 0 ? `${pass} passed · ${skip} skipped` : plural(pass, "check"),
  };
}

function reviewsCell(c: PrConversation): PulseCell {
  const users = c.reviewers.filter((r) => r.kind === "user");
  const approvers = users.filter((r) => r.verdict === "approved").map((r) => r.actor.login);
  const blockers = users.filter((r) => r.verdict === "changes_requested").map((r) => r.actor.login);
  const waiting = c.reviewers
    .filter((r) => r.requested && (r.kind === "team" || r.verdict === null))
    .map((r) => (r.kind === "team" ? r.name : r.actor.login));

  if (blockers.length > 0 || c.reviewDecision === "changes_requested") {
    return {
      tone: "bad",
      title: "Changes requested",
      detail: blockers.length > 0 ? `by ${names(blockers)}` : "A reviewer asked for changes",
    };
  }
  if (c.reviewDecision === "approved" || (c.reviewDecision === null && approvers.length > 0)) {
    return {
      tone: "good",
      title: "Approved",
      detail: approvers.length > 0 ? `by ${names(approvers)}` : "Review requirements met",
    };
  }
  if (c.reviewDecision === "review_required") {
    return {
      tone: "pending",
      title: "Review required",
      detail: waiting.length > 0 ? `Waiting on ${names(waiting)}` : "No reviewer requested yet",
    };
  }
  if (waiting.length > 0) {
    return { tone: "pending", title: "Requested", detail: `Waiting on ${names(waiting)}` };
  }
  return { tone: "neutral", title: "None yet", detail: "No reviews requested" };
}

function mergeCell(
  c: PrConversation,
  state: PulseStateKind,
  eligibility: MergeEligibility | null,
  baseRef: string,
): PulseCell {
  if (state === "merged") {
    const merged = lastOf(c.timeline, "merged");
    return {
      tone: "good",
      title: "Merged",
      detail: `into ${merged?.baseRef ?? baseRef}${merged?.commitSha ? ` as ${merged.commitSha.slice(0, 7)}` : ""}`,
    };
  }
  if (state === "closed") return { tone: "neutral", title: "Closed", detail: "Not merged" };
  if (state === "draft") return { tone: "neutral", title: "Draft", detail: "Not ready for review" };
  if (!eligibility) return { tone: "neutral", title: "Checking", detail: "Asking GitHub" };
  const status = eligibility.mergeStateStatus.toUpperCase();
  if (status === "DIRTY") return { tone: "bad", title: "Conflicts", detail: `with ${baseRef}` };
  if (status === "BEHIND")
    return { tone: "pending", title: "Behind", detail: `${baseRef} moved on` };
  const gate = mergeGate({
    mergeStateStatus: status,
    reviewDecision: c.reviewDecision,
    ciState: c.ci?.state ?? null,
    canBypassProtections: eligibility.canBypassProtections,
  });
  if (gate.kind === "open")
    return { tone: "good", title: "Ready", detail: `No conflicts with ${baseRef}` };
  if (gate.kind === "bypass") return { tone: "pending", title: "Admin only", detail: gate.rule };
  return { tone: "pending", title: "Blocked", detail: gate.reason };
}

const VERB: Partial<Record<TimelineItem["kind"], string>> = {
  comment: "commented",
  commit: "pushed",
  force_pushed: "force-pushed",
  labeled: "added a label",
  unlabeled: "removed a label",
  assigned: "assigned someone",
  unassigned: "unassigned someone",
  review_requested: "requested a review",
  review_request_removed: "removed a review request",
  review_dismissed: "dismissed a review",
  ready_for_review: "marked it ready",
  converted_to_draft: "converted it to a draft",
  closed: "closed it",
  reopened: "reopened it",
  merged: "merged it",
  renamed: "renamed it",
  added_to_stack: "stacked it",
  removed_from_stack: "unstacked it",
  cross_referenced: "mentioned it",
};

const REVIEW_VERB = {
  approved: "approved",
  changes_requested: "requested changes",
  commented: "reviewed",
  dismissed: "reviewed",
} as const;

export function itemActor(item: TimelineItem): ConversationActor {
  return "author" in item ? item.author : item.actor;
}

/** "hugo approved", "alex pushed": the item as a two-word clause. */
export function describeItem(item: TimelineItem): string {
  const who = itemActor(item).login;
  if (item.kind === "review") return `${who} ${REVIEW_VERB[item.verdict]}`;
  return `${who} ${VERB[item.kind] ?? "updated it"}`;
}

function activityCell(c: PrConversation): PulseCell {
  const commits = c.timeline.filter((t) => t.kind === "commit").length;
  const talk = c.timeline.filter(
    (t) => (t.kind === "comment" || t.kind === "review") && itemActor(t).kind !== "bot",
  ).length;
  const last = c.timeline.at(-1);
  const parts = [commits > 0 ? plural(commits, "commit") : null, plural(talk, "comment")];
  return {
    tone: "neutral",
    title: parts.filter(Boolean).join(" · "),
    detail: last ? `Last: ${describeItem(last)}` : "Nothing yet",
  };
}

function headlineFor(
  c: PrConversation,
  state: PulseStateKind,
  cells: { checks: PulseCell; reviews: PulseCell; merge: PulseCell },
  baseRef: string,
): Pick<PrPulse, "headline" | "actor" | "at" | "headlineTone"> {
  if (state === "merged") {
    const merged = lastOf(c.timeline, "merged");
    return {
      headline: `${merged?.actor.login ?? "Someone"} merged this into ${merged?.baseRef ?? baseRef}`,
      actor: merged?.actor ?? null,
      at: merged?.createdAt ?? null,
      headlineTone: "good",
    };
  }
  if (state === "closed") {
    const closed = c.timeline.findLast((t) => t.kind === "closed");
    const actor = closed ? itemActor(closed) : null;
    return {
      headline: `${actor?.login ?? "Someone"} closed this without merging`,
      actor,
      at: closed?.createdAt ?? null,
      headlineTone: "neutral",
    };
  }
  if (state === "draft") {
    return {
      headline: `${c.author.login} is still working on this draft`,
      actor: c.author,
      at: c.timeline.at(-1)?.createdAt ?? c.createdAt,
      headlineTone: "neutral",
    };
  }
  const { checks, reviews, merge } = cells;
  // The first thing in the way, in the order someone would fix it.
  if (merge.tone === "bad") {
    return {
      headline: `Conflicts with ${baseRef} block the merge`,
      actor: null,
      at: null,
      headlineTone: "bad",
    };
  }
  if (checks.tone === "bad") {
    return {
      headline: `${checks.title} ${checks.title.startsWith("1 ") ? "check" : "checks"}`,
      actor: null,
      at: null,
      headlineTone: "bad",
    };
  }
  if (reviews.tone === "bad") {
    return {
      headline: `Changes requested ${reviews.detail}`,
      actor: null,
      at: null,
      headlineTone: "bad",
    };
  }
  if (merge.tone === "good" && checks.tone !== "pending") {
    return { headline: "Ready to merge", actor: null, at: null, headlineTone: "good" };
  }
  // Several things can be outstanding at once; name them together.
  const waiting = [
    checks.tone === "pending" ? "checks" : null,
    reviews.tone !== "pending"
      ? null
      : reviews.detail.startsWith("Waiting on ")
        ? reviews.detail.replace(/^Waiting on /, "a review from ")
        : "a reviewer",
  ].filter((part): part is string => part !== null);
  if (waiting.length > 0) {
    return {
      headline: `Waiting on ${waiting.join(" and ")}`,
      actor: null,
      at: null,
      headlineTone: "pending",
    };
  }
  if (merge.title === "Behind") {
    return {
      headline: `Behind ${baseRef}: update the branch to merge`,
      actor: null,
      at: null,
      headlineTone: "pending",
    };
  }
  if (merge.tone === "pending")
    return { headline: merge.detail, actor: null, at: null, headlineTone: "pending" };
  return { headline: "Open for review", actor: null, at: null, headlineTone: "neutral" };
}

export function prPulse(
  c: PrConversation,
  eligibility: MergeEligibility | null,
  baseRef: string,
): PrPulse {
  const state: PulseStateKind =
    c.state === "merged"
      ? "merged"
      : c.state === "closed"
        ? "closed"
        : c.isDraft
          ? "draft"
          : "open";
  const checks = checksCell(c);
  const reviews = reviewsCell(c);
  const merge = mergeCell(c, state, eligibility, baseRef);
  return {
    state,
    ...headlineFor(c, state, { checks, reviews, merge }, baseRef),
    checks,
    reviews,
    merge,
    activity: activityCell(c),
  };
}

/**
 * Timeline items newer than `since`, minus the viewer's own: the things that
 * happened while they were away.
 */
export function itemsSince(
  timeline: readonly TimelineItem[],
  since: string | null,
  viewerLogin: string,
): TimelineItem[] {
  if (!since) return [];
  const cutoff = Date.parse(since);
  const me = viewerLogin.toLowerCase();
  return timeline.filter(
    (t) => Date.parse(t.createdAt) > cutoff && itemActor(t).login.toLowerCase() !== me,
  );
}

export interface FreshLine {
  readonly key: string;
  readonly actor: ConversationActor;
  /** "pushed 3 commits", "approved", "left 2 comments". */
  readonly text: string;
}

const COUNTED: Partial<Record<TimelineItem["kind"], [string, string]>> = {
  commit: ["pushed", "commit"],
  comment: ["left", "comment"],
  force_pushed: ["force-pushed", "time"],
};

/** Runs of the same person doing the same thing read as one line with a count. */
export function summarizeFresh(items: readonly TimelineItem[]): FreshLine[] {
  const lines: {
    key: string;
    actor: ConversationActor;
    kind: TimelineItem["kind"];
    count: number;
    first: TimelineItem;
  }[] = [];
  for (const item of items) {
    const actor = itemActor(item);
    const last = lines.at(-1);
    if (last && last.actor.login === actor.login && last.kind === item.kind && COUNTED[item.kind]) {
      last.count += 1;
      continue;
    }
    lines.push({ key: item.id, actor, kind: item.kind, count: 1, first: item });
  }
  return lines.map(({ key, actor, kind, count, first }) => {
    const counted = COUNTED[kind];
    if (!counted || count === 1)
      return { key, actor, text: describeItem(first).slice(actor.login.length + 1) };
    const [verb, noun] = counted;
    return {
      key,
      actor,
      text:
        kind === "force_pushed" ? `force-pushed ${count} times` : `${verb} ${plural(count, noun)}`,
    };
  });
}
