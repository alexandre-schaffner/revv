import { createHash } from "node:crypto";
import { resolveThinkingEffort, type StackHeadline } from "@revv/shared";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Semaphore } from "effect";
import { generateStackHeadline } from "../../ai/providers/stack-headline";
import { pullRequests } from "../../db/schema/pull-requests";
import { stackBriefs } from "../../db/schema/stack-briefs";
import { DbError } from "../../domain/errors";
import { withDb } from "../../effects/with-db";
import { Broadcaster } from "../Broadcaster";
import { CacheService } from "../Cache";
import { DbService } from "../Db";
import { SettingsService } from "../Settings";
import { firstSentence, headlineFromTitles } from "./headline";

const CACHE_NS = "stack-headline";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 60 * 1000;

interface NamedStack {
  readonly headline: string;
  readonly gist: string;
}

interface StackMembers {
  readonly stackNumber: number;
  readonly base: string;
  readonly layers: ReadonlyArray<{ number: number; title: string; body: string | null }>;
}

export class StackHeadlineService extends Context.Service<
  StackHeadlineService,
  {
    /**
     * A headline per stack of the repo's open PRs, keyed by stack number.
     * Never waits on a model: unnamed stacks answer their titles' name and
     * are named in the background.
     */
    readonly forRepo: (
      repositoryId: string,
      accountId: string,
    ) => Effect.Effect<Record<number, StackHeadline>, DbError>;
  }
>()("StackHeadlineService") {}

function namingKey(repositoryId: string, stack: StackMembers): string {
  const digest = createHash("sha256")
    .update(stack.base)
    .update(stack.layers.map((l) => `${l.number}:${l.title}`).join("\n"))
    .digest("hex")
    .slice(0, 24);
  return `${repositoryId}:${stack.stackNumber}:${digest}`;
}

export const StackHeadlineServiceLive = Layer.effect(
  StackHeadlineService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const cache = yield* CacheService;
    const settings = yield* SettingsService;
    const broadcaster = yield* Broadcaster;

    const naming = yield* Semaphore.make(1);
    const inflight = new Set<string>();
    const failedUntil = new Map<string, number>();

    const readStacks = (repositoryId: string) =>
      Effect.try({
        try: () => {
          const rows = db
            .select({
              number: pullRequests.externalId,
              title: pullRequests.title,
              body: pullRequests.body,
              targetBranch: pullRequests.targetBranch,
              stackNumber: pullRequests.stackNumber,
              stackPosition: pullRequests.stackPosition,
            })
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, repositoryId),
                eq(pullRequests.status, "open"),
                isNotNull(pullRequests.stackNumber),
              ),
            )
            .all();
          const byStack = Map.groupBy(rows, (r) => r.stackNumber ?? 0);
          const stacks: StackMembers[] = [];
          for (const [stackNumber, members] of byStack) {
            if (members.length < 2) continue;
            const ordered = members.toSorted(
              (a, b) => (a.stackPosition ?? 0) - (b.stackPosition ?? 0),
            );
            stacks.push({
              stackNumber,
              base: ordered[0]?.targetBranch ?? "",
              layers: ordered.map((m) => ({ number: m.number, title: m.title, body: m.body })),
            });
          }
          return stacks;
        },
        catch: (cause) => new DbError({ message: "stack headline read failed", cause }),
      });

    const briefGist = (repositoryId: string, stackNumber: number) =>
      Effect.try({
        try: () => {
          const row = db
            .select({ arc: stackBriefs.arc })
            .from(stackBriefs)
            .where(
              and(
                eq(stackBriefs.repositoryId, repositoryId),
                eq(stackBriefs.stackNumber, stackNumber),
                eq(stackBriefs.status, "complete"),
                isNull(stackBriefs.supersededBy),
              ),
            )
            .orderBy(desc(stackBriefs.completedAt))
            .get();
          return row ? firstSentence(row.arc) : null;
        },
        catch: (cause) => new DbError({ message: "stack brief read failed", cause }),
      });

    const name = (repositoryId: string, accountId: string, stack: StackMembers, key: string) =>
      Effect.gen(function* () {
        const current = yield* settings.getSettings();
        const model = current.aiSuggestionsModel;
        if (!model) return;
        const agent = yield* settings.resolveAgent();
        const named = yield* Effect.promise(() =>
          generateStackHeadline({
            base: stack.base,
            layersBaseFirst: stack.layers,
            acpAgentId: agent,
            cwd: process.cwd(),
            model,
            thinkingEffort: resolveThinkingEffort(current.aiThinkingEffort),
          }),
        );
        if (!named) {
          failedUntil.set(key, Date.now() + RETRY_AFTER_MS);
          return;
        }
        yield* withDb(db, cache.set<NamedStack>(CACHE_NS, key, named, { ttlMs: CACHE_TTL_MS }));
        yield* broadcaster.broadcastToAccount(accountId, {
          type: "stack:updated",
          data: { repositoryId, stackNumber: stack.stackNumber },
        });
      }).pipe(
        naming.withPermits(1),
        Effect.ensuring(Effect.sync(() => inflight.delete(key))),
        Effect.catchCause(() =>
          Effect.sync(() => failedUntil.set(key, Date.now() + RETRY_AFTER_MS)),
        ),
      );

    const forRepo = (repositoryId: string, accountId: string) =>
      Effect.gen(function* () {
        const stacks = yield* readStacks(repositoryId);
        const out: Record<number, StackHeadline> = {};
        for (const stack of stacks) {
          const key = namingKey(repositoryId, stack);
          const named = yield* withDb(db, cache.get<NamedStack>(CACHE_NS, key));
          const gist = yield* briefGist(repositoryId, stack.stackNumber);
          if (named) {
            out[stack.stackNumber] = {
              headline: named.headline,
              gist: gist ?? named.gist,
              source: gist ? "brief" : "model",
            };
            continue;
          }
          out[stack.stackNumber] = {
            headline: headlineFromTitles(stack.layers.map((l) => l.title)),
            gist,
            source: gist ? "brief" : "titles",
          };
          if (!inflight.has(key) && (failedUntil.get(key) ?? 0) <= Date.now()) {
            failedUntil.delete(key);
            inflight.add(key);
            yield* Effect.forkDetach(name(repositoryId, accountId, stack, key));
          }
        }
        return out;
      });

    return { forRepo };
  }),
);
