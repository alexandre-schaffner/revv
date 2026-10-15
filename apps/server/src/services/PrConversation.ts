// ── PR conversation service ─────────────────────────────────────────────────
//
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
  ConversationWrite,
  ConversationWriteResult,
  PrConversation,
  PrConversationResponse,
  PrLabel,
  ReviewerOptions,
} from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  type DbError,
  type GitHubError,
  GitHubNetworkError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from "../domain/errors";
import { logError } from "../logger";
import { Broadcaster } from "./Broadcaster";
import { CacheService } from "./Cache";
import {
  fetchCheckDetails,
  fetchCiRollup,
  fetchCodeowners,
  fetchConversation,
  listRepoLabels,
  type RepoRef,
  searchAssignableUsers,
  searchOrgTeams,
} from "./conversation/github";
import { runWrite } from "./conversation/writes";
import type { DbService } from "./Db";
import type { GitHubEtagCache } from "./GitHubEtagCache";
import { type PrContextBasic, type PrContextError, PrContextService } from "./PrContext";
import { RemoteUserService } from "./RemoteUser";

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

type ConversationError = GitHubError | PrContextError | DbError;
type Deps = DbService | GitHubEtagCache;

export class PrConversationService extends Context.Service<
  PrConversationService,
  {
    /** The last cached conversation, or null. Never touches GitHub. */
    readonly cached: (
      prId: string,
      userId: string,
      accountId: string,
    ) => Effect.Effect<PrConversation | null, ConversationError, Deps>;
    /**
     * A fresh conversation from GitHub. Falls back to the cached snapshot
     * (`stale: true`) when GitHub is unreachable or rate-limited.
     */
    readonly load: (
      prId: string,
      userId: string,
      accountId: string,
    ) => Effect.Effect<PrConversationResponse, ConversationError, Deps>;
    /** The head commit's CI rollup only; cheap enough to poll. */
    readonly checks: (
      prId: string,
      userId: string,
      accountId: string,
    ) => Effect.Effect<
      { readonly rollup: CiRollup | null; readonly access: CiAccess },
      ConversationError,
      Deps
    >;
    readonly checkDetails: (
      prId: string,
      userId: string,
      accountId: string,
      checkRunId: number,
    ) => Effect.Effect<CheckDetails, ConversationError, Deps>;
    /**
     * Apply a write on GitHub, then answer the refreshed conversation (null
     * when the re-read failed; the write still landed).
     */
    readonly write: (
      prId: string,
      userId: string,
      accountId: string,
      write: ConversationWrite,
    ) => Effect.Effect<ConversationWriteResult, ConversationError, Deps>;
    readonly labelOptions: (
      prId: string,
      userId: string,
      accountId: string,
    ) => Effect.Effect<PrLabel[], ConversationError, Deps>;
    readonly assigneeOptions: (
      prId: string,
      userId: string,
      accountId: string,
      query: string,
    ) => Effect.Effect<ActorOption[], ConversationError, Deps>;
    readonly reviewerOptions: (
      prId: string,
      userId: string,
      accountId: string,
      query: string,
    ) => Effect.Effect<ReviewerOptions, ConversationError, Deps>;
  }
>()("PrConversationService") {}

function repoRef(ctx: PrContextBasic): Effect.Effect<RepoRef, GitHubNotFoundError> {
  const [owner, repo, ...rest] = ctx.repo.fullName.split("/");
  return owner && repo && rest.length === 0
    ? Effect.succeed({ owner, repo })
    : Effect.fail(new GitHubNotFoundError({ resource: "repo", id: ctx.repo.fullName }));
}

// ── Avatars ─────────────────────────────────────────────────────────────────

function loginsOf(conversation: PrConversation): Set<string> {
  const logins = new Set<string>([conversation.author.login]);
  for (const a of [...conversation.assignees, ...conversation.participants]) logins.add(a.login);
  for (const r of conversation.reviewers) if (r.kind === "user") logins.add(r.actor.login);
  for (const t of conversation.timeline) {
    logins.add("author" in t ? t.author.login : t.actor.login);
  }
  return logins;
}

/** GitHub couldn't be reached; the cached snapshot is the honest answer. */
function isUnreachable(e: ConversationError): boolean {
  return e instanceof GitHubNetworkError || e instanceof GitHubRateLimitError;
}

export const PrConversationServiceLive = Layer.effect(
  PrConversationService,
  Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const cache = yield* CacheService;
    const remoteUsers = yield* RemoteUserService;
    const broadcaster = yield* Broadcaster;

    const resolveAvatars = (logins: Iterable<string>) => remoteUsers.getAvatarContents([...logins]);

    /**
     * Cache avatars the conversation shows but `remote_users` lacks. Runs
     * detached: the first paint uses initials, the next read has the image.
     */
    const warmAvatars = (urls: Map<string, string>, known: ReadonlyMap<string, string>) =>
      Effect.forEach(
        [...urls].filter(([login]) => !known.has(login)),
        ([login, avatarUrl]) =>
          remoteUsers.upsert({ provider: "github", providerUserId: "", login, avatarUrl }),
        { concurrency: 4, discard: true },
      ).pipe(Effect.forkDetach, Effect.asVoid);

    const codeownersFor = (ctx: PrContextBasic, ref: RepoRef) =>
      cache.getOrFetch(
        CODEOWNERS_NS,
        `${ctx.repo.fullName}:${ctx.pr.targetBranch}`,
        () => fetchCodeowners(ref, ctx.pr.targetBranch, ctx.token, ctx.apiBase),
        { ttlMs: CODEOWNERS_TTL_MS },
      );

    /** Fill in the avatars `remote_users` holds for everyone the conversation names. */
    const withAvatars = (conversation: PrConversation) =>
      Effect.map(resolveAvatars(loginsOf(conversation)), (known) => ({
        conversation: { ...conversation, avatars: Object.fromEntries(known) },
        known,
      }));

    const fetchFresh = (ctx: PrContextBasic, prId: string) =>
      Effect.gen(function* () {
        const ref = yield* repoRef(ctx);
        const [{ conversation: mapped, avatarUrls }, codeowners] = yield* Effect.all(
          [
            fetchConversation(ref, ctx.pr.externalId, prId, ctx.token, ctx.apiBase),
            codeownersFor(ctx, ref),
          ],
          { concurrency: 2 },
        );
        // Cached without images: they live in `remote_users`, and every read
        // fills them in from there.
        const snapshot: PrConversation = { ...mapped, codeowners, avatars: {} };
        yield* cache.set(CACHE_NS, prId, snapshot, { ttlMs: CACHE_TTL_MS });
        const { conversation, known } = yield* withAvatars(snapshot);
        yield* warmAvatars(avatarUrls, known);
        return conversation;
      });

    const readCached = (prId: string) =>
      Effect.gen(function* () {
        const snapshot = yield* cache.get<PrConversation>(CACHE_NS, prId);
        if (!snapshot) return null;
        return (yield* withAvatars(snapshot)).conversation;
      });

    const cached = (prId: string, userId: string, accountId: string) =>
      Effect.gen(function* () {
        yield* prContext.resolveBasic(prId, userId, accountId);
        return yield* readCached(prId);
      });

    const load = (prId: string, userId: string, accountId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        return yield* fetchFresh(ctx, prId).pipe(
          Effect.map((conversation): PrConversationResponse => ({ conversation, stale: false })),
          Effect.catchIf(isUnreachable, (err) =>
            Effect.flatMap(readCached(prId), (snapshot) =>
              snapshot
                ? Effect.succeed<PrConversationResponse>({ conversation: snapshot, stale: true })
                : Effect.fail(err),
            ),
          ),
        );
      });

    const checks = (prId: string, userId: string, accountId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        const answer = yield* fetchCiRollup(
          yield* repoRef(ctx),
          ctx.pr.externalId,
          ctx.token,
          ctx.apiBase,
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

    const checkDetails = (prId: string, userId: string, accountId: string, checkRunId: number) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        const key = `${ctx.repo.fullName}:${checkRunId}`;
        const hit = yield* cache.get<CheckDetails>(DETAILS_NS, key);
        if (hit?.completed) return hit;
        const details = yield* fetchCheckDetails(
          yield* repoRef(ctx),
          checkRunId,
          ctx.token,
          ctx.apiBase,
        );
        // A finished run's output never changes; a running one will.
        if (details.completed) {
          yield* cache.set(DETAILS_NS, key, details, { ttlMs: 7 * 24 * 60 * 60 * 1000 });
        }
        return details;
      });

    const write = (prId: string, userId: string, accountId: string, w: ConversationWrite) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        yield* runWrite(yield* repoRef(ctx), ctx.pr.externalId, w, ctx.token, ctx.apiBase);
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
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "pr:conversation-updated",
          data: { prId, fetchedAt: conversation?.fetchedAt ?? null },
        });
        return { conversation } satisfies ConversationWriteResult;
      });

    const labelOptions = (prId: string, userId: string, accountId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        return yield* listRepoLabels(yield* repoRef(ctx), ctx.token, ctx.apiBase);
      });

    const searchUsers = (ctx: PrContextBasic, query: string) =>
      Effect.gen(function* () {
        const users = yield* searchAssignableUsers(
          yield* repoRef(ctx),
          query,
          ctx.token,
          ctx.apiBase,
        );
        const known = yield* resolveAvatars(users.map((u) => u.login));
        yield* warmAvatars(
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

    const assigneeOptions = (prId: string, userId: string, accountId: string, query: string) =>
      Effect.flatMap(prContext.resolveBasic(prId, userId, accountId), (ctx) =>
        searchUsers(ctx, query),
      );

    const reviewerOptions = (prId: string, userId: string, accountId: string, query: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        const ref = yield* repoRef(ctx);
        const [users, teams] = yield* Effect.all(
          [searchUsers(ctx, query), searchOrgTeams(ref, query, ctx.token, ctx.apiBase)],
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
      checks,
      checkDetails,
      write,
      labelOptions,
      assigneeOptions,
      reviewerOptions,
    };
  }),
);
