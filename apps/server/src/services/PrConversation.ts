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
// broadcast).

import type {
  ActorOption,
  CheckDetails,
  CiAccess,
  CiRollup,
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
  GitHubRateLimitError,
} from "../domain/errors";
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
import * as writes from "./conversation/writes";
import type { DbService } from "./Db";
import type { GitHubEtagCache } from "./GitHubEtagCache";
import { type PrContextBasic, type PrContextError, PrContextService } from "./PrContext";
import { RemoteUserService } from "./RemoteUser";

const CACHE_NS = "pr-conversation";
const DETAILS_NS = "pr-check-details";
const CODEOWNERS_NS = "pr-codeowners";
/** CODEOWNERS rarely moves; a base branch's copy is re-read at most this often. */
const CODEOWNERS_TTL_MS = 10 * 60 * 1000;

/** A write the sidebar, composer, or checks section asks for. */
export type ConversationWrite =
  | { readonly kind: "request_reviewers"; readonly users: string[]; readonly teams: string[] }
  | { readonly kind: "remove_reviewers"; readonly users: string[]; readonly teams: string[] }
  | { readonly kind: "add_assignees"; readonly logins: string[] }
  | { readonly kind: "remove_assignees"; readonly logins: string[] }
  | { readonly kind: "add_labels"; readonly names: string[] }
  | { readonly kind: "remove_label"; readonly name: string }
  | { readonly kind: "post_comment"; readonly body: string }
  | { readonly kind: "edit_comment"; readonly commentId: number; readonly body: string }
  | { readonly kind: "delete_comment"; readonly commentId: number }
  | { readonly kind: "edit_body"; readonly body: string }
  | { readonly kind: "rerun_failed"; readonly runId: number }
  | { readonly kind: "rerun_job"; readonly jobId: number };

type ConversationError = GitHubError | PrContextError | DbError;
type Deps = DbService | GitHubEtagCache;

export class PrConversationService extends Context.Tag("PrConversationService")<
  PrConversationService,
  {
    /** The last cached conversation, or null. Never touches GitHub. */
    readonly cached: (
      prId: string,
      userId: string,
    ) => Effect.Effect<PrConversation | null, ConversationError, Deps>;
    /**
     * A fresh conversation from GitHub. Falls back to the cached snapshot
     * (`stale: true`) when GitHub is unreachable or rate-limited.
     */
    readonly load: (
      prId: string,
      userId: string,
    ) => Effect.Effect<PrConversationResponse, ConversationError, Deps>;
    /** The head commit's CI rollup only; cheap enough to poll. */
    readonly checks: (
      prId: string,
      userId: string,
    ) => Effect.Effect<
      { readonly rollup: CiRollup | null; readonly access: CiAccess },
      ConversationError,
      Deps
    >;
    readonly checkDetails: (
      prId: string,
      userId: string,
      checkRunId: number,
    ) => Effect.Effect<CheckDetails, ConversationError, Deps>;
    /** Apply a write on GitHub, then answer the refreshed conversation. */
    readonly write: (
      prId: string,
      userId: string,
      accountId: string,
      write: ConversationWrite,
    ) => Effect.Effect<PrConversation, ConversationError, Deps>;
    readonly labelOptions: (
      prId: string,
      userId: string,
    ) => Effect.Effect<PrLabel[], ConversationError, Deps>;
    readonly assigneeOptions: (
      prId: string,
      userId: string,
      query: string,
    ) => Effect.Effect<ActorOption[], ConversationError, Deps>;
    readonly reviewerOptions: (
      prId: string,
      userId: string,
      query: string,
    ) => Effect.Effect<ReviewerOptions, ConversationError, Deps>;
  }
>() {}

function repoRef(ctx: PrContextBasic): RepoRef {
  const [owner = "", repo = ""] = ctx.repo.fullName.split("/");
  return { owner, repo };
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

    const resolveAvatars = (logins: Iterable<string>) =>
      Effect.gen(function* () {
        const found = new Map<string, string>();
        for (const login of logins) {
          const content = yield* remoteUsers.getAvatarContent(login);
          if (content) found.set(login, content);
        }
        return found;
      });

    /**
     * Cache avatars the conversation shows but `remote_users` lacks. Runs
     * detached: the first paint uses initials, the next read has the image.
     */
    const warmAvatars = (urls: Map<string, string>, known: Map<string, string>) =>
      Effect.forEach(
        [...urls].filter(([login]) => !known.has(login)),
        ([login, avatarUrl]) =>
          remoteUsers.upsert({ provider: "github", providerUserId: "", login, avatarUrl }),
        { concurrency: 4, discard: true },
      ).pipe(Effect.forkDaemon, Effect.asVoid);

    const codeownersFor = (ctx: PrContextBasic) =>
      cache.getOrFetch(
        CODEOWNERS_NS,
        `${ctx.repo.fullName}:${ctx.pr.targetBranch}`,
        () => fetchCodeowners(repoRef(ctx), ctx.pr.targetBranch, ctx.token, ctx.apiBase),
        { ttlMs: CODEOWNERS_TTL_MS },
      );

    const fetchFresh = (ctx: PrContextBasic, prId: string) =>
      Effect.gen(function* () {
        const [{ conversation, avatarUrls }, codeowners] = yield* Effect.all(
          [
            fetchConversation(repoRef(ctx), ctx.pr.externalId, prId, ctx.token, ctx.apiBase),
            codeownersFor(ctx),
          ],
          { concurrency: 2 },
        );
        const known = yield* resolveAvatars(loginsOf(conversation));
        yield* warmAvatars(avatarUrls, known);
        const withImages = { ...conversation, codeowners, avatars: Object.fromEntries(known) };
        yield* cache.set(CACHE_NS, prId, withImages, { immutable: true });
        return withImages;
      });

    const readCached = (prId: string) =>
      Effect.gen(function* () {
        const snapshot = yield* cache.get<PrConversation>(CACHE_NS, prId);
        if (!snapshot) return null;
        // Avatars cached since the snapshot was written fill in now.
        const known = yield* resolveAvatars(loginsOf(snapshot));
        return { ...snapshot, avatars: Object.fromEntries(known) };
      });

    const cached = (prId: string, userId: string) =>
      Effect.gen(function* () {
        yield* prContext.resolveBasic(prId, userId);
        return yield* readCached(prId);
      });

    const load = (prId: string, userId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId);
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

    const checks = (prId: string, userId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId);
        const answer = yield* fetchCiRollup(
          repoRef(ctx),
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
            { immutable: true },
          );
        }
        return answer;
      });

    const checkDetails = (prId: string, userId: string, checkRunId: number) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId);
        const key = `${ctx.repo.fullName}:${checkRunId}`;
        const hit = yield* cache.get<CheckDetails>(DETAILS_NS, key);
        if (hit) return hit;
        const details = yield* fetchCheckDetails(repoRef(ctx), checkRunId, ctx.token, ctx.apiBase);
        // A finished run's output never changes; a running one will.
        if (details.logUnavailable !== "running") {
          yield* cache.set(DETAILS_NS, key, details, { ttlMs: 7 * 24 * 60 * 60 * 1000 });
        }
        return details;
      });

    const apply = (ctx: PrContextBasic, w: ConversationWrite) => {
      const ref = repoRef(ctx);
      const n = ctx.pr.externalId;
      const { token, apiBase } = ctx;
      switch (w.kind) {
        case "request_reviewers":
          return writes.requestReviewers(ref, n, w, token, apiBase);
        case "remove_reviewers":
          return writes.removeReviewers(ref, n, w, token, apiBase);
        case "add_assignees":
          return writes.addAssignees(ref, n, w.logins, token, apiBase);
        case "remove_assignees":
          return writes.removeAssignees(ref, n, w.logins, token, apiBase);
        case "add_labels":
          return writes.addLabels(ref, n, w.names, token, apiBase);
        case "remove_label":
          return writes.removeLabel(ref, n, w.name, token, apiBase);
        case "post_comment":
          return writes.postIssueComment(ref, n, w.body, token, apiBase);
        case "edit_comment":
          return writes.editIssueComment(ref, w.commentId, w.body, token, apiBase);
        case "delete_comment":
          return writes.deleteIssueComment(ref, w.commentId, token, apiBase);
        case "edit_body":
          return writes.editPrBody(ref, n, w.body, token, apiBase);
        case "rerun_failed":
          return writes.rerunFailedJobs(ref, w.runId, token, apiBase);
        case "rerun_job":
          return writes.rerunJob(ref, w.jobId, token, apiBase);
      }
    };

    const write = (prId: string, userId: string, accountId: string, w: ConversationWrite) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId);
        yield* apply(ctx, w);
        const conversation = yield* fetchFresh(ctx, prId);
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "pr:conversation-updated",
          data: { prId },
        });
        return conversation;
      });

    const labelOptions = (prId: string, userId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId);
        return yield* listRepoLabels(repoRef(ctx), ctx.token, ctx.apiBase);
      });

    const searchUsers = (ctx: PrContextBasic, query: string) =>
      Effect.gen(function* () {
        const users = yield* searchAssignableUsers(repoRef(ctx), query, ctx.token, ctx.apiBase);
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

    const assigneeOptions = (prId: string, userId: string, query: string) =>
      Effect.flatMap(prContext.resolveBasic(prId, userId), (ctx) => searchUsers(ctx, query));

    const reviewerOptions = (prId: string, userId: string, query: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId);
        const [users, teams] = yield* Effect.all(
          [searchUsers(ctx, query), searchOrgTeams(repoRef(ctx), query, ctx.token, ctx.apiBase)],
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
