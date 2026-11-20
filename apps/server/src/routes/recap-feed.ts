import {
  canonicalWindow,
  type RecapSourceScope,
  recapScopeCovers,
  rollingWindow,
} from "@revv/shared";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { RecapNotFoundError, ValidationError } from "../domain/errors";
import { GitHubGateway } from "../services/github/gateway";
import type { GitHubClient } from "../services/github/transport";
import { PrContextService } from "../services/PrContext";
import { ProjectRecapService } from "../services/recaps/ProjectRecap";
import { ProjectRecapJobs } from "../services/recaps/ProjectRecapJobs";
import { errorResponse, runRoute, withAccount } from "./middleware";

const selection = {
  repoId: t.Optional(t.String()),
  org: t.Optional(t.String()),
  team: t.Optional(t.String()),
};
const querySchema = t.Object({
  ...selection,
  period: t.Union([t.Literal("daily"), t.Literal("weekly")]),
  cursor: t.Optional(t.String()),
  recapId: t.Optional(t.String()),
  from: t.Optional(t.String({ format: "date-time" })),
  to: t.Optional(t.String({ format: "date-time" })),
});

interface Selection {
  repoId?: string;
  org?: string;
  team?: string;
}

export function resolveRecapScope(
  accountId: string,
  client: GitHubClient,
  selection: Selection,
  snapshotTeams = false,
) {
  return Effect.gen(function* () {
    const context = yield* PrContextService;
    const github = yield* GitHubGateway;
    const repos = yield* context.listReposForAccount(accountId);
    if (selection.repoId) {
      if (selection.team || selection.org)
        return yield* Effect.fail(
          new ValidationError({ message: "Choose a repository or a team" }),
        );
      const repo = repos.find((r) => r.id === selection.repoId);
      if (!repo)
        return yield* Effect.fail(
          new ValidationError({ message: "Repository is not available to this account" }),
        );
      return { repoId: repo.id, scope: undefined, label: repo.fullName };
    }
    if (Boolean(selection.org) !== Boolean(selection.team))
      return yield* Effect.fail(
        new ValidationError({ message: "Both organization and GitHub team are required" }),
      );
    const org = selection.org?.toLowerCase();
    const team = selection.team?.toLowerCase();
    const scopedRepos = org ? repos.filter((r) => r.owner.toLowerCase() === org) : repos;
    let scope: RecapSourceScope = {
      key: JSON.stringify([accountId, "all"]),
      kind: "all",
      accountId,
      label: "Everything",
      repositoryIds: scopedRepos.map((r) => r.id),
    };
    if (org && team) {
      const githubTeam = snapshotTeams
        ? (yield* github.repos.teamsForOrg(client, org)).find((t) => t.slug.toLowerCase() === team)
        : { slug: team, name: selection.team ?? team, memberLogins: [] };
      if (!githubTeam)
        return yield* Effect.fail(
          new ValidationError({ message: "GitHub team not found or not accessible" }),
        );
      scope = {
        ...scope,
        key: JSON.stringify([accountId, "team", org, team]),
        kind: "team",
        label: `${selection.org} / ${githubTeam.name}`,
        org,
        teamSlug: team,
        memberLogins: githubTeam.memberLogins,
        teams: [
          {
            org,
            slug: team,
            name: githubTeam.name,
            memberLogins: githubTeam.memberLogins,
            repositoryIds: scopedRepos.map((repo) => repo.id),
          },
        ],
      };
    }
    if (snapshotTeams && scope.kind === "all") {
      const teams = yield* Effect.forEach(
        [...new Set(scopedRepos.map((repo) => repo.owner))],
        (org) =>
          github.repos.teamsForOrg(client, org).pipe(
            Effect.map((teams) =>
              teams.map((team) => ({
                org,
                slug: team.slug,
                name: team.name,
                memberLogins: team.memberLogins,
                repositoryIds: scopedRepos
                  .filter((repo) => repo.owner.toLowerCase() === org.toLowerCase())
                  .map((repo) => repo.id),
              })),
            ),
            Effect.catch(() => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      scope = { ...scope, teams: teams.flat() };
    }
    return { repoId: scopedRepos[0]?.id, scope, label: scope.label };
  });
}

/** Shared authorization for detail, generation controls, and SSE. */
export function getRecapForAccount(id: string, accountId: string) {
  return Effect.flatMap(ProjectRecapService, (service) => service.getById(id, accountId));
}

export const recapFeedRoutes = new Elysia({ prefix: "/api/recap-feed" })
  .use(withAccount)
  .get(
    "/",
    async (ctx) => {
      try {
        return await runRoute(
          Effect.gen(function* () {
            const canonical = yield* resolveRecapScope(
              ctx.account.accountId,
              ctx.account.client,
              {},
            );
            const service = yield* ProjectRecapService;
            const params = {
              period: ctx.query.period,
              ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
              ...(ctx.query.from ? { from: ctx.query.from, limit: 100 } : {}),
              ...(ctx.query.to ? { to: ctx.query.to } : {}),
            };
            let resolved = canonical;
            let result = yield* service.listForRepo(canonical.repoId ?? "", {
              ...params,
              scopeKey: canonical.scope?.key ?? "",
            });
            if (ctx.query.repoId || ctx.query.team) {
              resolved = yield* resolveRecapScope(
                ctx.account.accountId,
                ctx.account.client,
                ctx.query,
              );
              result = {
                ...result,
                recaps: result.recaps.filter((recap) =>
                  recapScopeCovers(recap.sourceScope, ctx.query),
                ),
              };
              const legacy = yield* service.listForRepo(resolved.repoId ?? "", {
                ...params,
                scopeKey: resolved.scope?.key ?? "",
              });
              const windows = new Set(result.recaps.map((r) => r.periodStart));
              result = {
                recaps: [
                  ...result.recaps,
                  ...legacy.recaps.filter((r) => !windows.has(r.periodStart)),
                ],
                nextCursor:
                  [result.nextCursor, legacy.nextCursor]
                    .filter((v): v is string => v !== null)
                    .sort()
                    .at(-1) ?? null,
              };
            }
            if (ctx.query.recapId && !result.recaps.some((r) => r.id === ctx.query.recapId)) {
              const chosen = yield* getRecapForAccount(ctx.query.recapId, ctx.account.accountId);
              const matches =
                (chosen.sourceScope?.key === canonical.scope?.key &&
                  recapScopeCovers(chosen.sourceScope, ctx.query)) ||
                (resolved.scope
                  ? chosen.sourceScope?.key === resolved.scope.key
                  : !chosen.sourceScope && chosen.repositoryId === resolved.repoId);
              if (!matches || chosen.period !== ctx.query.period)
                return yield* Effect.fail(new RecapNotFoundError({ recapId: chosen.id }));
              const summary = {
                id: chosen.id,
                repositoryId: chosen.repositoryId,
                sourceScope: chosen.sourceScope ?? null,
                period: chosen.period,
                periodStart: chosen.periodStart,
                periodEnd: chosen.periodEnd,
                status: chosen.status,
                generatedAt: chosen.generatedAt,
                completedAt: chosen.completedAt,
                sourcePrCount: chosen.sourcePrIds.length,
                summaryStats: chosen.summaryStats,
                errorMessage: chosen.errorMessage,
              };
              return { ...result, recaps: [...result.recaps, summary], label: resolved.label };
            }
            return { ...result, label: resolved.label };
          }),
        );
      } catch (e) {
        return errorResponse(e);
      }
    },
    { query: querySchema },
  )
  .post(
    "/generate",
    async (ctx) => {
      try {
        return await runRoute(
          Effect.gen(function* () {
            const resolved = yield* resolveRecapScope(
              ctx.account.accountId,
              ctx.account.client,
              ctx.body,
              true,
            );
            if (!resolved.repoId)
              return yield* Effect.fail(
                new ValidationError({
                  message: "Add a repository to this scope before generating a recap",
                }),
              );
            const jobs = yield* ProjectRecapJobs;
            const period = ctx.body.period;
            const boundaries = ctx.body.periodStart
              ? canonicalWindow(period, ctx.body.periodStart)
              : rollingWindow(period);
            // A broad generation is also the source for its narrower views. A
            // scoped Generate request must not spend tokens to reproduce it.
            if (ctx.body.repoId || ctx.body.team) {
              const service = yield* ProjectRecapService;
              const covering = yield* service.findActiveForPeriod(
                resolved.repoId,
                period,
                boundaries.periodStart,
                JSON.stringify([ctx.account.accountId, "all"]),
              );
              if (
                covering &&
                (covering.status === "complete" || covering.status === "generating") &&
                recapScopeCovers(covering.sourceScope, ctx.body)
              )
                return { recapId: covering.id };
            }
            return yield* jobs.requestRecap({
              repoId: resolved.repoId,
              ...(resolved.scope ? { sourceScope: resolved.scope } : {}),
              period,
              window: boundaries,
              intent: "regenerate",
            });
          }),
        );
      } catch (e) {
        return errorResponse(e);
      }
    },
    {
      body: t.Object({
        ...selection,
        period: t.Union([t.Literal("daily"), t.Literal("weekly")]),
        periodStart: t.Optional(t.String({ format: "date-time" })),
      }),
    },
  );
