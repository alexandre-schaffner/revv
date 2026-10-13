import type {
  ConversationActor,
  PrLabel,
  TimelineComment,
  TimelineCommit,
  TimelineEvent,
  TimelineItem,
  TimelineReview,
} from "@revv/shared";

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
  | { readonly kind: "single"; readonly key: string; readonly event: TimelineEvent };

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

/** Fold `next` into `prev` when both are the same kind of burst. */
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
