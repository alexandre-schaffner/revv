import type {
  ConversationActor,
  PrLabel,
  TimelineComment,
  TimelineCommit,
  TimelineEvent,
  TimelineItem,
  TimelineReview,
} from "@revv/shared";
import { loginsMatch } from "@revv/shared";

/**
 * One line in a run of minor events. Bursts GitHub records as separate events
 * (a bot adding three labels, a CODEOWNERS file requesting four reviewers)
 * read as one sentence, the way GitHub's own timeline shows them.
 */
export type EventLine =
  | {
      readonly kind: "labels";
      readonly key: string;
      readonly actor: ConversationActor;
      readonly createdAt: string;
      readonly added: readonly PrLabel[];
      readonly removed: readonly PrLabel[];
    }
  | {
      readonly kind: "review_requests";
      readonly key: string;
      readonly actor: ConversationActor;
      readonly createdAt: string;
      readonly requested: readonly string[];
      readonly removed: readonly string[];
    }
  | { readonly kind: "single"; readonly key: string; readonly event: SingleEvent };

type FoldedKind = "labeled" | "unlabeled" | "review_requested" | "review_request_removed";
type SingleEvent = Exclude<TimelineEvent, { readonly kind: FoldedKind }>;

export type TimelineRow =
  | { readonly kind: "comment"; readonly key: string; readonly item: TimelineComment }
  | { readonly kind: "review"; readonly key: string; readonly item: TimelineReview }
  | { readonly kind: "commits"; readonly key: string; readonly commits: readonly TimelineCommit[] }
  | { readonly kind: "events"; readonly key: string; readonly lines: readonly EventLine[] };

/** Events this close together, by the same actor, merge into one line. */
const BURST_MS = 2 * 60 * 1000;

function within(a: string, b: string): boolean {
  return Math.abs(Date.parse(a) - Date.parse(b)) <= BURST_MS;
}

function toLine(event: TimelineEvent): EventLine {
  switch (event.kind) {
    case "labeled":
    case "unlabeled":
      return {
        kind: "labels",
        key: event.id,
        actor: event.actor,
        createdAt: event.createdAt,
        added: event.kind === "labeled" ? [event.label] : [],
        removed: event.kind === "unlabeled" ? [event.label] : [],
      };
    case "review_requested":
    case "review_request_removed":
      return {
        kind: "review_requests",
        key: event.id,
        actor: event.actor,
        createdAt: event.createdAt,
        requested: event.kind === "review_requested" ? [event.reviewer] : [],
        removed: event.kind === "review_request_removed" ? [event.reviewer] : [],
      };
    default:
      return { kind: "single", key: event.id, event };
  }
}

/** `a` then `b`, each key once: add, remove, re-add names a label twice. */
function union<T>(a: readonly T[], b: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((item) => !seen.has(key(item)) && seen.add(key(item)))];
}

const labelName = (label: PrLabel) => label.name;
const same = (name: string) => name;

function merge(prev: EventLine, next: EventLine): EventLine | null {
  if (prev.kind === "single" || next.kind !== prev.kind) return null;
  if (prev.actor.login !== next.actor.login || !within(prev.createdAt, next.createdAt)) {
    return null;
  }
  if (prev.kind === "labels" && next.kind === "labels") {
    return {
      ...prev,
      added: union(prev.added, next.added, labelName),
      removed: union(prev.removed, next.removed, labelName),
    };
  }
  if (prev.kind === "review_requests" && next.kind === "review_requests") {
    return {
      ...prev,
      requested: union(prev.requested, next.requested, same),
      removed: union(prev.removed, next.removed, same),
    };
  }
  return null;
}

/**
 * Group the timeline for display: consecutive commits become one "pushed N
 * commits" block, consecutive minor events one block of event lines (with
 * bursts merged), and comments and reviews stand alone.
 */
export function groupTimeline(items: readonly TimelineItem[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const item of items) {
    const last = rows.at(-1);
    switch (item.kind) {
      case "comment":
        rows.push({ kind: "comment", key: item.id, item });
        break;
      case "review":
        rows.push({ kind: "review", key: item.id, item });
        break;
      case "commit":
        if (last?.kind === "commits") {
          rows[rows.length - 1] = { ...last, commits: [...last.commits, item] };
        } else {
          rows.push({ kind: "commits", key: item.id, commits: [item] });
        }
        break;
      default: {
        const line = toLine(item);
        if (last?.kind !== "events") {
          rows.push({ kind: "events", key: item.id, lines: [line] });
          break;
        }
        const prior = last.lines.at(-1);
        const merged = prior ? merge(prior, line) : null;
        const lines = merged ? [...last.lines.slice(0, -1), merged] : [...last.lines, line];
        rows[rows.length - 1] = { ...last, lines };
      }
    }
  }
  return rows;
}

/** One run of a timeline sentence; adjacent text runs read as one. */
export type Phrase =
  | { readonly kind: "text" | "strong" | "code" | "del" | "quote"; readonly text: string }
  | { readonly kind: "labels"; readonly labels: readonly PrLabel[] }
  | { readonly kind: "link"; readonly text: string; readonly url: string };

export type EventIcon =
  | "labels"
  | "review-requests"
  | "assigned"
  | "unassigned"
  | "dismissed"
  | "force-pushed"
  | "pull-request"
  | "draft"
  | "merged"
  | "closed"
  | "renamed"
  | "stack"
  | "reference";

/** A state change GitHub draws as a filled, coloured rail glyph. */
export type EventTone = "merged" | "closed" | "open" | null;

export interface EventDescription {
  readonly icon: EventIcon;
  readonly tone: EventTone;
  /** What the actor did, after their name. */
  readonly phrases: readonly Phrase[];
}

const text = (value: string): Phrase => ({ kind: "text", text: value });
const strong = (value: string): Phrase => ({ kind: "strong", text: value });
const code = (value: string): Phrase => ({ kind: "code", text: value });
const shortSha = (sha: string | null) => sha?.slice(0, 7) ?? "unknown";

function list(names: readonly string[]): string {
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

export function describeEvent(line: EventLine, actorLogin: string): EventDescription {
  switch (line.kind) {
    case "labels": {
      const phrases: Phrase[] = [];
      if (line.added.length > 0)
        phrases.push(text("added"), { kind: "labels", labels: line.added });
      if (line.removed.length > 0) {
        phrases.push(text(line.added.length > 0 ? "and removed" : "removed"), {
          kind: "labels",
          labels: line.removed,
        });
      }
      phrases.push(text(line.added.length + line.removed.length === 1 ? "label" : "labels"));
      return { icon: "labels", tone: null, phrases };
    }
    case "review_requests": {
      const phrases: Phrase[] = [];
      if (line.requested.length > 0) {
        phrases.push(text("requested a review from"), strong(list(line.requested)));
      }
      if (line.removed.length > 0) {
        phrases.push(
          text(`${line.requested.length > 0 ? "and removed" : "removed"} the request for`),
          strong(list(line.removed)),
        );
      }
      return { icon: "review-requests", tone: null, phrases };
    }
    case "single":
      return describeSingle(line.event, actorLogin);
  }
}

function describeSingle(event: SingleEvent, actorLogin: string): EventDescription {
  switch (event.kind) {
    case "assigned":
      return {
        icon: "assigned",
        tone: null,
        phrases: loginsMatch(event.assignee, actorLogin)
          ? [text("self-assigned this")]
          : [text("assigned"), strong(event.assignee)],
      };
    case "unassigned":
      return {
        icon: "unassigned",
        tone: null,
        phrases: loginsMatch(event.assignee, actorLogin)
          ? [text("removed their assignment")]
          : [text("unassigned"), strong(event.assignee)],
      };
    case "review_dismissed": {
      const whose = event.reviewer ? `${event.reviewer}'s` : "a";
      return {
        icon: "dismissed",
        tone: null,
        phrases: event.message
          ? [text(`dismissed ${whose} review:`), { kind: "quote", text: event.message }]
          : [text(`dismissed ${whose} review`)],
      };
    }
    case "force_pushed":
      return {
        icon: "force-pushed",
        tone: null,
        phrases: [
          text("force-pushed from"),
          code(shortSha(event.beforeSha)),
          text("to"),
          code(shortSha(event.afterSha)),
        ],
      };
    case "ready_for_review":
      return {
        icon: "pull-request",
        tone: "open",
        phrases: [text("marked this ready for review")],
      };
    case "reopened":
      return { icon: "pull-request", tone: "open", phrases: [text("reopened this")] };
    case "converted_to_draft":
      return { icon: "draft", tone: null, phrases: [text("converted this to a draft")] };
    case "merged":
      return {
        icon: "merged",
        tone: "merged",
        phrases: [
          text("merged"),
          code(shortSha(event.commitSha)),
          text("into"),
          code(event.baseRef),
        ],
      };
    case "closed":
      return { icon: "closed", tone: "closed", phrases: [text("closed this")] };
    case "renamed":
      return {
        icon: "renamed",
        tone: null,
        phrases: [
          text("renamed this from"),
          { kind: "del", text: event.from },
          text("to"),
          { kind: "quote", text: event.to },
        ],
      };
    case "added_to_stack":
      return {
        icon: "stack",
        tone: null,
        phrases: [text("added this to stack"), strong(`#${event.stackNumber}`)],
      };
    case "removed_from_stack":
      return {
        icon: "stack",
        tone: null,
        phrases: [text("removed this from stack"), strong(`#${event.stackNumber}`)],
      };
    case "cross_referenced":
      return {
        icon: "reference",
        tone: null,
        phrases: [
          text("mentioned this in"),
          {
            kind: "link",
            text: `${event.source.repo}#${event.source.number} ${event.source.title}`,
            url: event.source.url,
          },
        ],
      };
  }
}
