// Serves the Conversation tab. GitHub is the source of truth: every read goes
// to GitHub, and the last good answer is kept in the kv cache so the tab
// paints instantly on reload and keeps something on screen when GitHub can't
// be reached (offline, rate-limited). Nothing here is journaled; losing the
// cache costs one fetch.
//
// Writes go to GitHub first, then the conversation is re-read, cached, and a
// `pr:conversation-updated` signal goes to the account (commit, then
// broadcast). The re-read is best effort: GitHub already took the write.

import type {
  ActorOption,
  CheckDetails,
  CiAccess,
  CiRollup,
  CodeownersFile,
  ConversationWrite,
  ConversationWriteResult,
  PrConversation,
  PrConversationResponse,
  PrLabel,
  PrOwnership,
  PrOwnershipResponse,
  ReviewerEntry,
  ReviewerOptions,
  ViewerTeam,
} from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import { type DbError, type GitHubError, isGitHubUnreachable } from "../domain/errors";
import { logError } from "../logger";
import { withGitHubOrigin } from "../observability/github-ledger/origin";
import { CacheService } from "./Cache";
import { GitHubAccounts } from "./github/accounts";
import { AvatarCache } from "./github/avatars";
import type { MappedConversation } from "./github/conversation/map";
import { GitHubGateway } from "./github/gateway";
import { type PrContextBasic, type PrContextError, PrContextService } from "./PrContext";
import { Realtime } from "./Realtime";

const CACHE_NS = "pr-conversation";
/**
 * The snapshot is a fallback for when GitHub can't be reached and a first
 * paint; a week-old one is still better than an empty tab, an older one is
 * clutter.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DETAILS_NS = "pr-check-details";
const CODEOWNERS_NS = "pr-codeowners";
/** CODEOWNERS rarely moves; a base branch's copy is re-read at most this often. */
const CODEOWNERS_TTL_MS = 10 * 60 * 1000;
const OWNERSHIP_NS = "pr-ownership";
// v2: each team carries its member count.
const VIEWER_TEAMS_NS = "viewer-teams-v2";
/** Team membership changes rarely; one org's answer serves every PR in it for this long. */
const VIEWER_TEAMS_TTL_MS = 60 * 60 * 1000;

type ConversationError = GitHubError | PrContextError | DbError;

export class PrConversationService extends Context.Service<
  PrConversationService,
  {
    /** The last cached conversation, or null. Never touches GitHub. */
    readonly cached: (prId: string) => Effect.Effect<PrConversation | null, ConversationError>;
    /**
     * A fresh conversation from GitHub. Falls back to the cached snapshot
     * (`stale: true`) when GitHub is unreachable or rate-limited.
     */
    readonly load: (prId: string) => Effect.Effect<PrConversationResponse, ConversationError>;
    /**
     * Who asked the viewer to review, and which CODEOWNERS rules make them
     * responsible: a light read that lands with the diff. Falls back to the
     * cached snapshot (`stale: true`) when GitHub is unreachable.
     */
    readonly ownership: (prId: string) => Effect.Effect<PrOwnershipResponse, ConversationError>;
    /** The head commit's CI rollup only; cheap enough to poll. */
    readonly checks: (
      prId: string,
    ) => Effect.Effect<
      { readonly rollup: CiRollup | null; readonly access: CiAccess },
      ConversationError
    >;
    readonly checkDetails: (
      prId: string,
      checkRunId: number,
    ) => Effect.Effect<CheckDetails, ConversationError>;
    /**
     * Apply a write on GitHub, then answer the refreshed conversation (null
     * when the re-read failed; the write still landed).
     */
    readonly write: (
      prId: string,
      write: ConversationWrite,
    ) => Effect.Effect<ConversationWriteResult, ConversationError>;
    /**
     * A write made outside `write` (a review submitted to GitHub) changed the
     * conversation: re-read it and announce `pr:conversation-updated`. The
     * conversation is null when the re-read failed; the write still stands,
     * so this never fails.
     */
    readonly afterWrite: (ctx: PrContextBasic) => Effect.Effect<ConversationWriteResult, never>;
    readonly labelOptions: (prId: string) => Effect.Effect<PrLabel[], ConversationError>;
    readonly assigneeOptions: (
      prId: string,
      query: string,
    ) => Effect.Effect<ActorOption[], ConversationError>;
    readonly reviewerOptions: (
      prId: string,
      query: string,
    ) => Effect.Effect<ReviewerOptions, ConversationError>;
  }
>()("PrConversationService") {}

function loginsOf(conversation: PrConversation): Set<string> {
  const logins = new Set<string>([conversation.author.login]);
  for (const a of [...conversation.assignees, ...conversation.participants]) logins.add(a.login);
  for (const r of conversation.reviewers) if (r.kind === "user") logins.add(r.actor.login);
  for (const t of conversation.timeline) {
    logins.add("author" in t ? t.author.login : t.actor.login);
  }
  return logins;
}

/** A snapshot cached by an older build may predate these fields. */
type SnapshotOnDisk = Omit<PrConversation, "viewerTeams" | "reviewers"> & {
  readonly viewerTeams?: ReadonlyArray<ViewerTeam | string>;
  readonly reviewers: ReadonlyArray<
    | Extract<ReviewerEntry, { kind: "team" }>
    | (Omit<Extract<ReviewerEntry, { kind: "user" }>, "onBehalfOf"> & {
        readonly onBehalfOf?: readonly string[];
      })
  >;
};

function upgradeSnapshot(snapshot: SnapshotOnDisk): PrConversation {
  return {
    ...snapshot,
    viewerTeams: (snapshot.viewerTeams ?? []).map((t) =>
      typeof t === "string" ? { combinedSlug: t, memberCount: 0 } : t,
    ),
    reviewers: snapshot.reviewers.map(
      (r): ReviewerEntry => (r.kind === "team" ? r : { ...r, onBehalfOf: r.onBehalfOf ?? [] }),
    ),
  };
}

export const PrConversationServiceLive = Layer.effect(
  PrConversationService,
  Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const accounts = yield* GitHubAccounts;
    const github = yield* GitHubGateway;
    const cache = yield* CacheService;
    const avatars = yield* AvatarCache;
    const realtime = yield* Realtime;

    /**
     * Cache avatars the conversation shows but `remote_users` lacks. Runs
     * detached: the first paint uses initials, the next read has the image.
     */
    const warmAvatars = (
      host: string,
      urls: Map<string, string>,
      known: ReadonlyMap<string, string>,
    ) =>
      Effect.forEach(
        [...urls].filter(([login]) => !known.has(login)),
        ([login, avatarUrl]) => avatars.ensure(host, login, avatarUrl),
        { concurrency: 4, discard: true },
      ).pipe(withGitHubOrigin("conversation:avatars"), Effect.forkDetach, Effect.asVoid);

    const codeownersFor = (ctx: PrContextBasic) =>
      cache.getOrFetch(
        CODEOWNERS_NS,
        `${ctx.repo.fullName}:${ctx.pr.targetBranch}`,
        () => github.conversation.codeowners(ctx.client, ctx.repo.fullName, ctx.pr.targetBranch),
        { ttlMs: CODEOWNERS_TTL_MS },
      );

    /** The viewer's teams in the repo's org; one org's answer serves every PR in it for an hour. */
    const teamsOf = (ctx: PrContextBasic, login: string) =>
      cache.getOrFetch(
        VIEWER_TEAMS_NS,
        `${ctx.repo.githubHost}:${ctx.repo.fullName.split("/")[0]}:${login}`.toLowerCase(),
        () => github.conversation.viewerTeams(ctx.client, ctx.repo.fullName, login),
        { ttlMs: VIEWER_TEAMS_TTL_MS },
      );

    /**
     * `read`, the base branch's CODEOWNERS and the viewer's teams, all at
     * once: the account's stored login lets the teams query start without
     * waiting for `read` to name the viewer. An account with no stored login
     * asks for the teams once `read` answers.
     */
    const withOwnersAndTeams = <A extends { readonly viewerLogin: string }, E>(
      ctx: PrContextBasic,
      read: Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const login = yield* accounts.viewerLogin(ctx.accountId);
        const [answer, codeowners, early] = yield* Effect.all(
          [read, codeownersFor(ctx), login ? teamsOf(ctx, login) : Effect.succeed(null)],
          { concurrency: 3 },
        );
        const viewerTeams = early ?? (yield* teamsOf(ctx, answer.viewerLogin));
        return { answer, codeowners, viewerTeams };
      });

    /** Fill in the avatars `remote_users` holds for everyone the conversation names. */
    const withAvatars = (host: string, conversation: PrConversation) =>
      Effect.map(avatars.contents(host, loginsOf(conversation)), (known) => ({
        conversation: { ...conversation, avatars: Object.fromEntries(known) },
        known,
      }));

    const fetchFresh = (ctx: PrContextBasic, prId: string) =>
      Effect.gen(function* () {
        const { answer, codeowners, viewerTeams } = yield* withOwnersAndTeams(
          ctx,
          github.conversation.fetch(ctx.client, ctx.repo.fullName, ctx.pr.externalId, prId).pipe(
            Effect.map((fetched) => ({
              ...fetched,
              viewerLogin: fetched.conversation.viewerLogin,
            })),
          ),
        );
        const { conversation: mapped, avatarUrls } = answer;
        // Cached without images: they live in `remote_users`, and every read
        // fills them in from there.
        const snapshot: PrConversation = { ...mapped, codeowners, viewerTeams, avatars: {} };
        yield* cache.set(CACHE_NS, prId, snapshot, { ttlMs: CACHE_TTL_MS });
        const { conversation, known } = yield* withAvatars(ctx.repo.githubHost, snapshot);
        yield* warmAvatars(ctx.repo.githubHost, avatarUrls, known);
        return conversation;
      });

    const readCached = (prId: string, host: string) =>
      Effect.gen(function* () {
        const snapshot = yield* cache.get<SnapshotOnDisk>(CACHE_NS, prId);
        if (!snapshot) return null;
        return (yield* withAvatars(host, upgradeSnapshot(snapshot))).conversation;
      });

    const cached = (prId: string) =>
      Effect.gen(function* () {
        const { repo } = yield* prContext.readPr(prId);
        return yield* readCached(prId, repo.githubHost);
      });

    const load = (prId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId);
        return yield* fetchFresh(ctx, prId).pipe(
          Effect.map((conversation): PrConversationResponse => ({ conversation, stale: false })),
          Effect.catchIf(isGitHubUnreachable, (err) =>
            Effect.flatMap(readCached(prId, ctx.repo.githubHost), (snapshot) =>
              snapshot
                ? Effect.succeed<PrConversationResponse>({ conversation: snapshot, stale: true })
                : Effect.fail(err),
            ),
          ),
        );
      });

    const fetchOwnership = (ctx: PrContextBasic, prId: string) =>
      Effect.gen(function* () {
        const { answer, codeowners, viewerTeams } = yield* withOwnersAndTeams(
          ctx,
          github.conversation.ownership(ctx.client, ctx.repo.fullName, ctx.pr.externalId),
        );
        const ownership: PrOwnership = { ...answer, codeowners, viewerTeams };
        yield* cache.set(OWNERSHIP_NS, prId, ownership, { ttlMs: CACHE_TTL_MS });
        return ownership;
      });

    /** The last ownership snapshot, or the conversation snapshot it is a part of. */
    const cachedOwnership = (prId: string) =>
      Effect.gen(function* () {
        const own = yield* cache.get<PrOwnership>(OWNERSHIP_NS, prId);
        if (own) return own;
        const snapshot = yield* cache.get<SnapshotOnDisk>(CACHE_NS, prId);
        return snapshot ? upgradeSnapshot(snapshot) : null;
      });

    const ownership = (prId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId);
        return yield* fetchOwnership(ctx, prId).pipe(
          Effect.map((own): PrOwnershipResponse => ({ ownership: own, stale: false })),
          Effect.catchIf(isGitHubUnreachable, (err) =>
            Effect.flatMap(cachedOwnership(prId), (snapshot) =>
              snapshot
                ? Effect.succeed<PrOwnershipResponse>({
                    ownership: {
                      viewerLogin: snapshot.viewerLogin,
                      viewerTeams: snapshot.viewerTeams,
                      author: snapshot.author,
                      reviewers: snapshot.reviewers,
                      codeowners: snapshot.codeowners,
                      timeline: snapshot.timeline.filter((t) => t.kind === "review_requested"),
                      fetchedAt: snapshot.fetchedAt,
                    },
                    stale: true,
                  })
                : Effect.fail(err),
            ),
          ),
        );
      });

    const checks = (prId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId);
        const answer = yield* github.conversation.ciRollup(
          ctx.client,
          ctx.repo.fullName,
          ctx.pr.externalId,
        );
        // Keep the snapshot's CI in step so a reload doesn't flash old checks.
        const snapshot = yield* cache.get<PrConversation>(CACHE_NS, prId);
        if (snapshot) {
          yield* cache.set(
            CACHE_NS,
            prId,
            { ...snapshot, ci: answer.rollup, ciAccess: answer.access },
            { ttlMs: CACHE_TTL_MS },
          );
        }
        return answer;
      });

    const checkDetails = (prId: string, checkRunId: number) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId);
        const key = `${ctx.repo.fullName}:${checkRunId}`;
        const hit = yield* cache.get<CheckDetails>(DETAILS_NS, key);
        if (hit?.completed) return hit;
        const details = yield* github.conversation.checkDetails(
          ctx.client,
          ctx.repo.fullName,
          checkRunId,
        );
        // A finished run's output never changes; a running one will.
        if (details.completed) {
          yield* cache.set(DETAILS_NS, key, details, { ttlMs: 7 * 24 * 60 * 60 * 1000 });
        }
        return details;
      });

    const afterWrite = (ctx: PrContextBasic) =>
      Effect.gen(function* () {
        const prId = ctx.pr.id;
        // GitHub took the write; failing to re-read it (rate limit, network)
        // must not read as the write failing, or the client rolls back a
        // change that landed and a retry duplicates it.
        const conversation = yield* fetchFresh(ctx, prId).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              logError("conversation", `re-read of ${prId} after a write failed`, err);
              return null;
            }),
          ),
        );
        yield* realtime.toAccount(ctx.accountId, {
          type: "pr:conversation-updated",
          data: { prId, fetchedAt: conversation?.fetchedAt ?? null },
        });
        return { conversation } satisfies ConversationWriteResult;
      });

    const write = (prId: string, w: ConversationWrite) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId);
        yield* github.conversation.write(ctx.client, ctx.repo.fullName, ctx.pr.externalId, w);
        return yield* afterWrite(ctx);
      });

    const labelOptions = (prId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId);
        return yield* github.conversation.labels(ctx.client, ctx.repo.fullName);
      });

    const searchUsers = (ctx: PrContextBasic, query: string) =>
      Effect.gen(function* () {
        const users = yield* github.conversation.assignableUsers(
          ctx.client,
          ctx.repo.fullName,
          query,
        );
        const known = yield* avatars.contents(
          ctx.repo.githubHost,
          users.map((u) => u.login),
        );
        yield* warmAvatars(
          ctx.repo.githubHost,
          new Map(users.flatMap((u) => (u.avatarUrl ? [[u.login, u.avatarUrl] as const] : []))),
          known,
        );
        return users.map(
          (u): ActorOption => ({
            login: u.login,
            name: u.name,
            avatarContent: known.get(u.login) ?? null,
          }),
        );
      });

    const assigneeOptions = (prId: string, query: string) =>
      Effect.flatMap(prContext.forPr(prId), (ctx) => searchUsers(ctx, query));

    const reviewerOptions = (prId: string, query: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId);
        const [users, teams] = yield* Effect.all(
          [
            searchUsers(ctx, query),
            github.conversation.orgTeams(ctx.client, ctx.repo.fullName, query),
          ],
          { concurrency: 2 },
        );
        // GitHub refuses a review request to the PR's author.
        return {
          users: users.filter((u) => u.login !== ctx.pr.authorLogin),
          teams,
        } satisfies ReviewerOptions;
      });

    return {
      cached,
      load,
      ownership,
      checks,
      checkDetails,
      write,
      afterWrite,
      labelOptions,
      assigneeOptions,
      reviewerOptions,
    };
  }),
);
