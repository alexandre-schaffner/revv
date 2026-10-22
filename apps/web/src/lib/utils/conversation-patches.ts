// Optimistic readings of the Conversation tab's writes. Each patch changes
// only the rows its write touches, and its undo puts back exactly those rows
// on whatever the conversation reads by then: a CI poll or another write may
// have replaced everything else meanwhile, and that must survive a rollback.

import type {
  ConversationActor,
  PrConversation,
  PrLabel,
  ReviewerEntry,
  TimelineComment,
  TimelineItem,
} from "@revv/shared";

export interface ConversationPatch {
  /** Called once, when the write starts; captures what it replaces. */
  readonly apply: (conversation: PrConversation) => PrConversation;
  /** Restores the captured rows; everything else stays as it now reads. */
  readonly undo: (conversation: PrConversation) => PrConversation;
}

/**
 * A patch over one keyed list. `change` rewrites the list; the undo puts each
 * key in `keys` back the way it read before: restored in place, re-inserted
 * at its old position, or dropped if it didn't exist.
 */
function keyedPatch<T>(
  read: (c: PrConversation) => readonly T[],
  write: (c: PrConversation, list: T[]) => PrConversation,
  keyOf: (item: T) => string,
  keys: readonly string[],
  change: (list: readonly T[], conversation: PrConversation) => T[],
): ConversationPatch {
  const affected = new Set(keys);
  let before = new Map<string, { item: T; index: number }>();
  return {
    apply: (c) => {
      const list = read(c);
      before = new Map(
        list.flatMap((item, index) =>
          affected.has(keyOf(item)) ? [[keyOf(item), { item, index }] as const] : [],
        ),
      );
      return write(c, change(list, c));
    },
    undo: (c) => {
      const restored = read(c).flatMap((item) => {
        const key = keyOf(item);
        if (!affected.has(key)) return [item];
        const prior = before.get(key);
        return prior ? [prior.item] : [];
      });
      const present = new Set(restored.map(keyOf));
      const missing = [...before].filter(([key]) => !present.has(key));
      for (const [, { item, index }] of missing.sort(([, a], [, b]) => a.index - b.index)) {
        restored.splice(Math.min(index, restored.length), 0, item);
      }
      return write(c, restored);
    },
  };
}

// ── Actors ──────────────────────────────────────────────────────────────────

function bareActor(login: string): ConversationActor {
  return { login, name: null, avatarContent: null, kind: "user" };
}

/** The viewer as the conversation knows them, avatar included when it has one. */
function viewerOf(c: PrConversation): ConversationActor {
  return c.participants.find((p) => p.login === c.viewerLogin) ?? bareActor(c.viewerLogin);
}

// ── Timeline ────────────────────────────────────────────────────────────────

const timelineOf = (c: PrConversation) => c.timeline;
const withTimeline = (c: PrConversation, timeline: TimelineItem[]) => ({ ...c, timeline });
const commentKey = (databaseId: number) => `comment:${databaseId}`;
const timelineKey = (t: TimelineItem) =>
  t.kind === "comment" && t.databaseId > 0 ? commentKey(t.databaseId) : t.id;

export function postCommentPatch(body: string, now: Date = new Date()): ConversationPatch {
  const createdAt = now.toISOString();
  const id = `pending-${createdAt}`;
  return keyedPatch(timelineOf, withTimeline, timelineKey, [id], (list, c) => [
    ...list,
    {
      kind: "comment",
      id,
      createdAt,
      databaseId: 0,
      author: viewerOf(c),
      body,
      edited: false,
      url: "",
      viewerCanUpdate: false,
      viewerCanDelete: false,
    } satisfies TimelineComment,
  ]);
}

export function editCommentPatch(commentId: number, body: string): ConversationPatch {
  return keyedPatch(timelineOf, withTimeline, timelineKey, [commentKey(commentId)], (list) =>
    list.map((t) =>
      t.kind === "comment" && t.databaseId === commentId ? { ...t, body, edited: true } : t,
    ),
  );
}

export function deleteCommentPatch(commentId: number): ConversationPatch {
  return keyedPatch(timelineOf, withTimeline, timelineKey, [commentKey(commentId)], (list) =>
    list.filter((t) => !(t.kind === "comment" && t.databaseId === commentId)),
  );
}

export function editBodyPatch(body: string): ConversationPatch {
  let before = "";
  return {
    apply: (c) => {
      before = c.body;
      return { ...c, body };
    },
    undo: (c) => ({ ...c, body: before }),
  };
}

// ── Reviewers ───────────────────────────────────────────────────────────────

export interface ReviewerChange {
  readonly users: readonly string[];
  readonly teams: readonly string[];
}

const reviewersOf = (c: PrConversation) => c.reviewers;
const withReviewers = (c: PrConversation, reviewers: ReviewerEntry[]) => ({ ...c, reviewers });
const reviewerKey = (r: ReviewerEntry) =>
  r.kind === "team" ? `team:${r.combinedSlug}` : `user:${r.actor.login}`;
const changeKeys = (change: ReviewerChange) => [
  ...change.users.map((login) => `user:${login}`),
  ...change.teams.map((slug) => `team:${slug}`),
];

export function requestReviewersPatch(change: ReviewerChange): ConversationPatch {
  return keyedPatch(reviewersOf, withReviewers, reviewerKey, changeKeys(change), (list) => {
    const reviewers = list.map((r) =>
      r.kind === "user" && change.users.includes(r.actor.login) ? { ...r, requested: true } : r,
    );
    const known = new Set(reviewers.map(reviewerKey));
    for (const login of change.users) {
      if (known.has(`user:${login}`)) continue;
      reviewers.push({
        kind: "user",
        actor: bareActor(login),
        requested: true,
        asCodeOwner: false,
        verdict: null,
        verdictAt: null,
      });
    }
    for (const combinedSlug of change.teams) {
      if (known.has(`team:${combinedSlug}`)) continue;
      const slug = combinedSlug.split("/").pop() ?? combinedSlug;
      reviewers.push({
        kind: "team",
        combinedSlug,
        slug,
        name: slug,
        requested: true,
        asCodeOwner: false,
      });
    }
    return reviewers;
  });
}

export function removeReviewersPatch(change: ReviewerChange): ConversationPatch {
  return keyedPatch(reviewersOf, withReviewers, reviewerKey, changeKeys(change), (list) =>
    list.flatMap((r): ReviewerEntry[] => {
      if (r.kind === "team") return change.teams.includes(r.combinedSlug) ? [] : [r];
      if (!change.users.includes(r.actor.login)) return [r];
      // Someone who already reviewed stays listed with their verdict.
      return r.verdict ? [{ ...r, requested: false }] : [];
    }),
  );
}

// ── Assignees and labels ────────────────────────────────────────────────────

const assigneesOf = (c: PrConversation) => c.assignees;
const withAssignees = (c: PrConversation, assignees: ConversationActor[]) => ({ ...c, assignees });
const loginOf = (a: ConversationActor) => a.login;

export function addAssigneesPatch(logins: readonly string[]): ConversationPatch {
  return keyedPatch(assigneesOf, withAssignees, loginOf, logins, (list, c) => [
    ...list,
    ...logins
      .filter((login) => !list.some((a) => a.login === login))
      .map((login) => (login === c.viewerLogin ? viewerOf(c) : bareActor(login))),
  ]);
}

export function removeAssigneesPatch(logins: readonly string[]): ConversationPatch {
  return keyedPatch(assigneesOf, withAssignees, loginOf, logins, (list) =>
    list.filter((a) => !logins.includes(a.login)),
  );
}

const labelsOf = (c: PrConversation) => c.labels;
const withLabels = (c: PrConversation, labels: PrLabel[]) => ({ ...c, labels });
const labelName = (l: PrLabel) => l.name;

export function addLabelsPatch(labels: readonly PrLabel[]): ConversationPatch {
  return keyedPatch(labelsOf, withLabels, labelName, labels.map(labelName), (list) => [
    ...list,
    ...labels.filter((l) => !list.some((existing) => existing.name === l.name)),
  ]);
}

export function removeLabelsPatch(names: readonly string[]): ConversationPatch {
  return keyedPatch(labelsOf, withLabels, labelName, names, (list) =>
    list.filter((l) => !names.includes(l.name)),
  );
}
