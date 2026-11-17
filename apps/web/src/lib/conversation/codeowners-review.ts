// ── Why am I asked to review this? ──────────────────────────────────────────
//
// GitHub says that you (or a team of yours) were requested, not which files
// made it so. The answer is the base branch's CODEOWNERS: the files whose
// last matching rule names you or one of your teams. Pure logic over the
// ownership read (or the conversation, which carries the same fields) and the
// PR's changed paths, so the files sidebar, the file tree, and the
// Conversation tab's Code owners section all read the same answer.
//
// A viewer can own a file several ways at once (themselves, a small team, a
// company-wide team). The narrowest is the one that says the most: a file
// only R&D owns matters more to an R&D member than one every developer owns.
// So groups rank narrowest first (the viewer alone, then the smallest team),
// and the sidebar scopes to the narrowest by default.

import {
  type CodeownersRule,
  codeownersRuleFor,
  loginsMatch,
  type PrOwnership,
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
  /** People it stands for: 1 for a person, the team's size, null when unknown. */
  readonly size: number | null;
  readonly status: OwnerStatus;
  /**
   * Logins whose approval stands for this owner: the user themselves, or the
   * team members who approved on the team's behalf.
   */
  readonly approvedBy: readonly string[];
  readonly changesRequestedBy: readonly string[];
}

/** A changed file in the chosen scope, and the rule that puts it there. */
export interface ScopedFile {
  readonly rule: CodeownersRule;
  /** The rule's owners that are in the scope, as written. */
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
  readonly totalFiles: number;
  /**
   * The viewer's groups first, narrowest first; then everyone else's, by
   * file count. Empty without a CODEOWNERS file.
   */
  readonly groups: readonly OwnerGroup[];
  /** The rule that decides each changed path; null when none matches. */
  readonly rules: ReadonlyMap<string, CodeownersRule | null>;
  /** Where the rules come from, e.g. `.github/CODEOWNERS`. Null without a file. */
  readonly source: string | null;
}

const handleOf = (owner: string): string => owner.replace(/^@/, "");

/** Narrowest first: a person, then the smallest team; unknown sizes last, then fewer files. */
function narrowestFirst(a: OwnerGroup, b: OwnerGroup): number {
  const size = (g: OwnerGroup) => g.size ?? Number.POSITIVE_INFINITY;
  return size(a) - size(b) || a.files.length - b.files.length || a.handle.localeCompare(b.handle);
}

export function reviewOwnership(src: PrOwnership, paths: readonly string[]): ReviewOwnership {
  const viewer = src.viewerLogin;
  const teamSize = new Map(
    src.viewerTeams.map((t) => [t.combinedSlug.toLowerCase(), t.memberCount] as const),
  );
  const sizeIfMine = (owner: string): number | null | undefined => {
    const handle = handleOf(owner);
    if (!handle.includes("/")) return loginsMatch(handle, viewer) ? 1 : undefined;
    const size = teamSize.get(handle.toLowerCase());
    return size === undefined ? undefined : size > 0 ? size : null;
  };

  const rules = codeownersRuleFor(src.codeowners?.rules ?? [], paths);
  const filesByOwner = new Map<string, string[]>();
  for (const [path, rule] of rules) {
    if (!rule) continue;
    for (const owner of rule.owners) {
      filesByOwner.set(owner, [...(filesByOwner.get(owner) ?? []), path]);
    }
  }

  const all = [...filesByOwner].map(([owner, files]) =>
    ownerGroup(owner, files, sizeIfMine(owner), src.reviewers),
  );
  const mine = all.filter((g) => g.mine).sort(narrowestFirst);
  const others = all
    .filter((g) => !g.mine)
    .sort((a, b) => b.files.length - a.files.length || a.handle.localeCompare(b.handle));

  return {
    reason: requestReason(src, new Set(teamSize.keys()), mine.length > 0),
    totalFiles: paths.length,
    groups: [...mine, ...others],
    rules,
    source: src.codeowners?.path ?? null,
  };
}

/** The scope the sidebar opens with: the viewer's narrowest group, if they own anything here. */
export function defaultScope(own: ReviewOwnership): string[] {
  const narrowest = own.groups.find((g) => g.mine);
  return narrowest ? [narrowest.owner] : [];
}

/** The changed files whose deciding rule names someone in `scope`. */
export function filesInScope(
  own: ReviewOwnership,
  scope: ReadonlySet<string>,
): Map<string, ScopedFile> {
  const files = new Map<string, ScopedFile>();
  if (scope.size === 0) return files;
  for (const [path, rule] of own.rules) {
    const via = rule?.owners.filter((o) => scope.has(o)) ?? [];
    if (rule && via.length > 0) files.set(path, { rule, via });
  }
  return files;
}

function ownerGroup(
  owner: string,
  files: string[],
  /** Undefined when the owner isn't the viewer or one of their teams. */
  size: number | null | undefined,
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
    mine: size !== undefined,
    size: size ?? null,
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
  conversation: PrOwnership,
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
function latestRequester(conversation: PrOwnership, reviewer: string): string | null {
  for (let i = conversation.timeline.length - 1; i >= 0; i--) {
    const item = conversation.timeline[i];
    if (item?.kind === "review_requested" && loginsMatch(item.reviewer, reviewer)) {
      return item.actor.kind === "ghost" ? null : item.actor.login;
    }
  }
  return null;
}

/** The header's one-line answer to "why am I asked to review this?". */
export function reasonText(reason: RequestReason): string {
  switch (reason.kind) {
    case "codeowners":
      return `Requested as ${reason.via.join(", ")} via CODEOWNERS`;
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

/** Hover text for a file in scope: who owns it, the rule, and where it lives. */
export function scopedFileTitle(file: ScopedFile, source: string): string {
  const owners = file.rule.owners.join(" ");
  return `Owned by ${file.via.join(", ")}\n${source}:${file.rule.line}  ${file.rule.pattern} ${owners}`;
}
