// ── Why am I asked to review this? ──────────────────────────────────────────
//
// GitHub says that you (or a team of yours) were requested, not which files
// made it so. The answer is the base branch's CODEOWNERS: the files whose
// last matching rule names you or one of your teams. Pure logic over the
// Conversation snapshot and the PR's changed paths, so the sidebar header,
// the file tree, and the Conversation tab's Code owners section all read the
// same answer.

import {
  type CodeownersRule,
  codeownersRuleFor,
  loginsMatch,
  type PrConversation,
  type ReviewerEntry,
} from "@revv/shared";

export type OwnerStatus = "approved" | "changes_requested" | "pending";

/** Everyone one CODEOWNERS owner answers for in this PR. */
export interface OwnerGroup {
  /** As written in CODEOWNERS: `@login`, `@org/team`, or an email. */
  readonly owner: string;
  /** `owner` without the `@`. */
  readonly handle: string;
  readonly team: boolean;
  /** The changed files whose last matching rule names this owner. Sorted. */
  readonly files: readonly string[];
  /** The viewer is this owner, or a member of this team. */
  readonly mine: boolean;
  readonly status: OwnerStatus;
  /**
   * Logins whose approval stands for this owner: the user themselves, or the
   * team members who approved on the team's behalf.
   */
  readonly approvedBy: readonly string[];
  readonly changesRequestedBy: readonly string[];
}

/** A changed file the viewer owns, and the rule that makes it so. */
export interface OwnedFile {
  readonly rule: CodeownersRule;
  /** The rule's owners that are the viewer or one of their teams, as written. */
  readonly via: readonly string[];
}

export type RequestReason =
  /** GitHub requested the viewer (or their teams) because CODEOWNERS names them. */
  | { readonly kind: "codeowners"; readonly via: readonly string[] }
  /** Someone asked by hand. `as` is the team they asked, null when they asked the viewer. */
  | {
      readonly kind: "direct";
      readonly as: string | null;
      readonly requestedBy: string | null;
      readonly byAuthor: boolean;
    }
  /** No open request (any more), but CODEOWNERS still names the viewer. */
  | { readonly kind: "owner" };

export interface ReviewOwnership {
  /** Null when the viewer wrote the PR, or has nothing to do with it. */
  readonly reason: RequestReason | null;
  /** Changed files owned by the viewer or their teams, by path. */
  readonly mine: ReadonlyMap<string, OwnedFile>;
  readonly totalFiles: number;
  /** Mine first, then by file count. Empty without a CODEOWNERS file. */
  readonly groups: readonly OwnerGroup[];
}

const handleOf = (owner: string): string => owner.replace(/^@/, "");

export function reviewOwnership(
  conversation: PrConversation,
  paths: readonly string[],
): ReviewOwnership {
  const viewer = conversation.viewerLogin;
  const myTeams = new Set(conversation.viewerTeams.map((t) => t.toLowerCase()));
  const isMine = (owner: string): boolean => {
    const handle = handleOf(owner);
    return handle.includes("/") ? myTeams.has(handle.toLowerCase()) : loginsMatch(handle, viewer);
  };

  const rules = codeownersRuleFor(conversation.codeowners?.rules ?? [], paths);
  const mine = new Map<string, OwnedFile>();
  const filesByOwner = new Map<string, string[]>();
  for (const [path, rule] of rules) {
    if (!rule) continue;
    const via = rule.owners.filter(isMine);
    if (via.length > 0) mine.set(path, { rule, via });
    for (const owner of rule.owners)
      filesByOwner.set(owner, [...(filesByOwner.get(owner) ?? []), path]);
  }

  const groups = [...filesByOwner]
    .map(([owner, files]) => ownerGroup(owner, files, isMine(owner), conversation.reviewers))
    .sort(
      (a, b) =>
        Number(b.mine) - Number(a.mine) ||
        b.files.length - a.files.length ||
        a.handle.localeCompare(b.handle),
    );

  return {
    reason: requestReason(conversation, myTeams, mine.size > 0),
    mine,
    totalFiles: paths.length,
    groups,
  };
}

function ownerGroup(
  owner: string,
  files: string[],
  mine: boolean,
  reviewers: readonly ReviewerEntry[],
): OwnerGroup {
  const handle = handleOf(owner);
  const team = handle.includes("/");
  const answered = (verdict: "approved" | "changes_requested"): string[] =>
    reviewers.flatMap((r) => {
      if (r.kind !== "user" || r.verdict !== verdict) return [];
      const answers = team
        ? r.onBehalfOf.some((t) => t.toLowerCase() === handle.toLowerCase())
        : loginsMatch(r.actor.login, handle);
      return answers ? [r.actor.login] : [];
    });
  const approvedBy = answered("approved");
  const changesRequestedBy = answered("changes_requested");
  return {
    owner,
    handle,
    team,
    files: files.sort(),
    mine,
    // Changes requested by an owner block the merge whatever else approved.
    status:
      changesRequestedBy.length > 0
        ? "changes_requested"
        : approvedBy.length > 0
          ? "approved"
          : "pending",
    approvedBy,
    changesRequestedBy,
  };
}

function requestReason(
  conversation: PrConversation,
  myTeams: ReadonlySet<string>,
  ownsFiles: boolean,
): RequestReason | null {
  const viewer = conversation.viewerLogin;
  // Authors aren't asked to review their own PR.
  if (loginsMatch(conversation.author.login, viewer)) return null;

  const direct = conversation.reviewers.find(
    (r): r is Extract<ReviewerEntry, { kind: "user" }> =>
      r.kind === "user" && r.requested && loginsMatch(r.actor.login, viewer),
  );
  const teams = conversation.reviewers.filter(
    (r): r is Extract<ReviewerEntry, { kind: "team" }> =>
      r.kind === "team" && myTeams.has(r.combinedSlug.toLowerCase()),
  );

  const via = [
    ...(direct?.asCodeOwner ? [`@${direct.actor.login}`] : []),
    ...teams.filter((t) => t.asCodeOwner).map((t) => `@${t.combinedSlug}`),
  ];
  if (via.length > 0) return { kind: "codeowners", via };

  const team = teams[0];
  if (direct || team) {
    const target = direct ? direct.actor.login : (team?.combinedSlug ?? "");
    const requestedBy = latestRequester(conversation, target);
    return {
      kind: "direct",
      as: direct ? null : `@${target}`,
      requestedBy,
      byAuthor: loginsMatch(requestedBy, conversation.author.login),
    };
  }
  return ownsFiles ? { kind: "owner" } : null;
}

/** Who last asked `reviewer` (a login or `org/slug`) for a review, from the timeline. */
function latestRequester(conversation: PrConversation, reviewer: string): string | null {
  for (let i = conversation.timeline.length - 1; i >= 0; i--) {
    const item = conversation.timeline[i];
    if (item?.kind === "review_requested" && loginsMatch(item.reviewer, reviewer)) {
      return item.actor.kind === "ghost" ? null : item.actor.login;
    }
  }
  return null;
}

/** "4 of 32 files". */
export function fileShare(owned: number, total: number): string {
  return `${owned} of ${total} ${total === 1 ? "file" : "files"}`;
}

/** The header's one-line answer to "why am I asked to review this?". */
export function reasonText(reason: RequestReason): string {
  switch (reason.kind) {
    case "codeowners": {
      const self = reason.via.length === 1 && !reason.via[0]?.includes("/");
      return self
        ? "Requested via CODEOWNERS"
        : `Requested as ${reason.via.join(", ")} via CODEOWNERS`;
    }
    case "direct": {
      const who = reason.byAuthor
        ? "the author"
        : reason.requestedBy
          ? `@${reason.requestedBy}`
          : null;
      if (reason.as)
        return who ? `Requested as ${reason.as} by ${who}` : `Requested as ${reason.as}`;
      return who ? `Requested directly by ${who}` : "Requested directly";
    }
    case "owner":
      return "You're a code owner";
  }
}

/** Hover text for a file the viewer owns: the rule and where it lives. */
export function ownedFileTitle(file: OwnedFile, source: string): string {
  const owners = file.rule.owners.join(" ");
  return `Owned by ${file.via.join(", ")}\n${source}:${file.rule.line}  ${file.rule.pattern} ${owners}`;
}
