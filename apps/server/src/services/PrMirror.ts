/**
 * The one writer of what GitHub says about a pull request. Every observation —
 * the poll's lists, a PR's detail, a closed PR's final state, the head after a
 * push from Revv, a deep link, a merge/close/draft Revv made — lands here, so
 * each gets the same follow-through:
 *
 * - a stale read never rewinds the stored head (`preserveHeadOnStaleRead`);
 * - the row, its diff size and the head that size describes are written in
 *   one statement;
 * - a trusted head move supersedes walkthroughs pinned to the old head
 *   (invariant 7), keeping one generating at the new head;
 * - a PR that went terminal is announced (`pr:archived`), its agent worktree
 *   reaped (unless someone works in it), and its stack marked stale;
 * - the account's clients hear `prs:updated`, after the commit (invariant 8).
 */
import {
  type PullRequest,
  type Repository,
  type ServerEventMessage,
  sameStack,
} from "@revv/shared";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { pullRequests } from "../db/schema/index";
import { type DbError, type GitHubError, GitHubNotFoundError } from "../domain/errors";
import { asStored, type ObservedPr, STACK_UNSEEN } from "../domain/observed-pr";
import { dbTry } from "../effects/db-try";
import { logError } from "../logger";
import { DbService } from "./Db";
import { GitHubGateway } from "./github/gateway";
import type { GitHubClient } from "./github/transport";
import { PullRequestService } from "./PullRequest";
import { isTrustedHeadShaMove, preserveHeadOnStaleRead } from "./pr-head-move";
import { Realtime } from "./Realtime";
import { RepositoryService } from "./Repository";
import { StackService } from "./stacks/StackService";
import { WalkthroughJobs } from "./walkthrough/WalkthroughJobs";
import { AgentWorktrees } from "./workspace/agent-worktrees";

export interface MirrorOptions {
  /**
   * Send `prs:updated` to the owning accounts once written (the default).
   * The poll batches its own announcement per cycle through {@link announce}.
   */
  readonly announce?: boolean;
}

/** What one {@link PrMirrorService.apply} changed. */
export interface MirrorOutcome {
  /** The rows as they now stand in SQLite. */
  readonly rows: readonly PullRequest[];
  /** Accounts whose PR list moved. */
  readonly accountIds: ReadonlySet<string>;
}

/** A change Revv made on GitHub itself, recorded without re-reading the PR. */
export type PrMutation =
  | { readonly kind: "draft"; readonly isDraft: boolean }
  | { readonly kind: "terminal"; readonly status: "merged" | "closed"; readonly closedAt: string };

export interface PrMirrorService {
  /**
   * Record GitHub's view of these PRs. `prior` is the stored rows the caller
   * already read, by id; rows it lacks are read here.
   */
  readonly apply: (
    observed: readonly ObservedPr[],
    options?: MirrorOptions & { readonly prior?: ReadonlyMap<string, PullRequest> },
  ) => Effect.Effect<MirrorOutcome, DbError>;
  readonly recordMutation: (prId: string, mutation: PrMutation) => Effect.Effect<void, DbError>;
  /**
   * Revv pushed these tips to the source branches of the repo's PRs (a chat
   * push, a base sync, a stack rebase): record each head before the next poll
   * would, from GitHub's detail when it already shows the push. The push
   * happened either way, so a failure here is logged, never returned.
   */
  readonly recordPushes: (
    at: { readonly repo: Repository; readonly client: GitHubClient },
    pushes: ReadonlyArray<{ readonly prNumber: number; readonly newTip: string }>,
  ) => Effect.Effect<void>;
  /**
   * The PR's head: the mirror's, or GitHub's when the mirror has none yet,
   * recorded first so every reader agrees on it.
   */
  readonly headOf: (ctx: {
    readonly pr: PullRequest;
    readonly repo: Repository;
    readonly client: GitHubClient;
  }) => Effect.Effect<string, GitHubError | DbError>;
  /** Send each account its full open-PR list (`prs:updated`). */
  readonly announce: (accountIds: Iterable<string>) => Effect.Effect<void>;
}

export class PrMirror extends Context.Service<PrMirror, PrMirrorService>()("PrMirror") {}

/** Stacks a write moved: a PR changed place, or a layer's diff range moved. */
export function movedStackNumbers(
  prs: readonly PullRequest[],
  prior: ReadonlyMap<string, PullRequest>,
): Set<number> {
  const moved = new Set<number>();
  for (const pr of prs) {
    const before = prior.get(pr.id);
    const placeMoved = !sameStack(before?.stack ?? null, pr.stack);
    const rangeMoved =
      before !== undefined && (before.headSha !== pr.headSha || before.baseSha !== pr.baseSha);
    if (!placeMoved && !rangeMoved) continue;
    if (pr.stack) moved.add(pr.stack.number);
    if (placeMoved && before?.stack) moved.add(before.stack.number);
  }
  return moved;
}

export const PrMirrorLive = Layer.effect(
  PrMirror,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const prService = yield* PullRequestService;
    const repoService = yield* RepositoryService;
    const walkthroughJobs = yield* WalkthroughJobs;
    const agentWorktrees = yield* AgentWorktrees;
    const stackService = yield* StackService;
    const realtime = yield* Realtime;
    const github = yield* GitHubGateway;

    const accountOf = (repoId: string) =>
      repoService.getAccountIdForRepo(repoId).pipe(
        Effect.map((id): string | null => id),
        Effect.catch((e) =>
          Effect.sync(() => {
            logError("PrMirror", `no account for repository ${repoId}:`, e);
            return null;
          }),
        ),
      );

    const announce = (accountIds: Iterable<string>) =>
      Effect.forEach(
        new Set(accountIds),
        (accountId) =>
          prService.listPrs(accountId).pipe(
            Effect.flatMap((prs) =>
              realtime.toAccount(accountId, { type: "prs:updated", data: prs }),
            ),
            Effect.catch((e) =>
              Effect.sync(() => logError("PrMirror", `prs:updated for ${accountId}:`, e)),
            ),
          ),
        { discard: true },
      );

    const supersede = (prId: string, headSha: string) =>
      walkthroughJobs
        .supersedeForPr(prId, headSha)
        .pipe(
          Effect.catch((err) =>
            Effect.sync(() => logError("PrMirror", `walkthrough supersede for ${prId}:`, err)),
          ),
        );

    const markStacksStale = (accountId: string, repositoryId: string, stacks: Iterable<number>) =>
      Effect.forEach(
        new Set(stacks),
        (stackNumber) => stackService.moved(accountId, repositoryId, stackNumber),
        { discard: true },
      );

    /** A PR that left the open list: announce it and reap its agent worktree. */
    const wentTerminal = (accountId: string, pr: PullRequest) =>
      Effect.gen(function* () {
        const message: ServerEventMessage = {
          type: "pr:archived",
          data: {
            prId: pr.id,
            repoId: pr.repositoryId,
            status: pr.status === "merged" ? "merged" : "closed",
            closedAt: pr.closedAt ?? new Date().toISOString(),
          },
        };
        yield* realtime.toAccount(accountId, message);
        // The prune takes the PR's workspace claim, and leaves a worktree
        // someone works in or with unpushed commits for the next sweep.
        yield* Effect.forkDetach(
          agentWorktrees
            .prune({ repoId: pr.repositoryId, prId: pr.id, prNumber: pr.externalId })
            .pipe(
              Effect.catch((err) =>
                Effect.sync(() => logError("PrMirror", `pruning ${pr.id}'s worktree:`, err)),
              ),
            ),
        );
      });

    /** Everything after the commit, for rows that went from `prior` to `rows`. */
    const followThrough = (
      rows: readonly PullRequest[],
      prior: ReadonlyMap<string, PullRequest>,
      headMoves: ReadonlyMap<string, string>,
    ) =>
      Effect.gen(function* () {
        const accountIds = new Set<string>();
        for (const [repoId, repoRows] of Map.groupBy(rows, (pr) => pr.repositoryId)) {
          const accountId = yield* accountOf(repoId);
          if (accountId === null) continue;
          accountIds.add(accountId);
          const stacks = movedStackNumbers(repoRows, prior);
          for (const pr of repoRows) {
            const before = prior.get(pr.id);
            if (pr.status === "open" || before?.status !== "open") continue;
            yield* wentTerminal(accountId, pr);
            if (before.stack) stacks.add(before.stack.number);
          }
          if (stacks.size > 0) yield* markStacksStale(accountId, repoId, stacks);
        }
        yield* Effect.forEach(headMoves, ([prId, headSha]) => supersede(prId, headSha), {
          discard: true,
        });
        return accountIds;
      });

    const readPrior = (ids: readonly string[], known?: ReadonlyMap<string, PullRequest>) =>
      Effect.gen(function* () {
        const prior = new Map<string, PullRequest>();
        for (const id of ids) {
          const row =
            known?.get(id) ??
            (yield* prService.getPr(id).pipe(
              Effect.map((pr): PullRequest | null => pr),
              Effect.catchTag("NotFoundError", () => Effect.succeed(null)),
            ));
          if (row) prior.set(id, row);
        }
        return prior;
      });

    const apply: PrMirrorService["apply"] = (observed, options = {}) =>
      Effect.gen(function* () {
        if (observed.length === 0) return { rows: [], accountIds: new Set() };
        const prior = yield* readPrior(
          observed.map((pr) => pr.id),
          options.prior,
        );
        // A read can lag (the list endpoint is cache-fronted, an ETag replay
        // can be stale): mask before writing so it never rewinds the head.
        const masked = observed.map((pr) => preserveHeadOnStaleRead(prior.get(pr.id), pr));
        yield* prService.upsertPrs(masked);
        const rows = masked.map((pr) => asStored(pr, prior.get(pr.id)));
        const headMoves = new Map<string, string>();
        for (const row of rows) {
          const before = prior.get(row.id);
          if (before && row.headSha !== null && isTrustedHeadShaMove(before, row)) {
            headMoves.set(row.id, row.headSha);
          }
        }
        const accountIds = yield* followThrough(rows, prior, headMoves);
        if (options.announce !== false) yield* announce(accountIds);
        return { rows, accountIds };
      });

    const recordMutation: PrMirrorService["recordMutation"] = (prId, mutation) =>
      Effect.gen(function* () {
        const before = yield* prService
          .getPr(prId)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)));
        if (!before) return;
        if (mutation.kind === "terminal" && before.status === mutation.status) return;
        let after: PullRequest;
        if (mutation.kind === "draft") {
          yield* prService.setPrDraft(prId, mutation.isDraft);
          after = { ...before, isDraft: mutation.isDraft };
        } else {
          yield* prService.markPrsClosed([
            { id: prId, status: mutation.status, closedAt: mutation.closedAt },
          ]);
          after = { ...before, status: mutation.status, closedAt: mutation.closedAt };
        }
        const accountIds = yield* followThrough([after], new Map([[prId, before]]), new Map());
        yield* announce(accountIds);
      });

    const recordPushes: PrMirrorService["recordPushes"] = ({ repo, client }, pushes) =>
      Effect.gen(function* () {
        if (pushes.length === 0) return;
        const ids = yield* dbTry("pushed PRs read", () =>
          db
            .select({ id: pullRequests.id, number: pullRequests.externalId })
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, repo.id),
                inArray(
                  pullRequests.externalId,
                  pushes.map((p) => p.prNumber),
                ),
              ),
            )
            .all(),
        );
        const prior = yield* readPrior(ids.map((row) => row.id));
        const now = new Date().toISOString();
        const observed: ObservedPr[] = [];
        for (const { prNumber, newTip } of pushes) {
          const pr = [...prior.values()].find((row) => row.externalId === prNumber);
          if (!pr) continue;
          const live = yield* github.prs
            .get(client, repo.fullName, repo.id, prNumber)
            .pipe(Effect.option);
          // Until GitHub's detail shows the push, its `updated_at` would make
          // the new head read as stale: stamp the push time with it instead.
          observed.push(
            Option.isSome(live) && live.value.headSha === newTip
              ? live.value
              : {
                  ...pr,
                  authorAvatarUrl: null,
                  stack: STACK_UNSEEN,
                  headSha: newTip,
                  updatedAt: now,
                  fetchedAt: now,
                },
          );
        }
        yield* apply(observed, { prior });
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() =>
            logError("PrMirror", `recording Revv's push to ${repo.fullName}:`, err),
          ),
        ),
      );

    const headOf: PrMirrorService["headOf"] = ({ pr, repo, client }) =>
      Effect.gen(function* () {
        if (pr.headSha) return pr.headSha;
        const live = yield* github.prs.get(client, repo.fullName, repo.id, pr.externalId);
        if (live.headSha === null) {
          return yield* Effect.fail(
            new GitHubNotFoundError({
              resource: "pull_request",
              id: `${repo.fullName}#${pr.externalId}`,
            }),
          );
        }
        yield* apply([live], { prior: new Map([[pr.id, pr]]) });
        return live.headSha;
      });

    return { apply, recordMutation, recordPushes, headOf, announce };
  }),
);
