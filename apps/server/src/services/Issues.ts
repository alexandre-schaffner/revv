import type { Issue } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { githubIssues, repositories } from "../db/schema/index";
import { type GitHubError, NotFoundError, ValidationError } from "../domain/errors";
import { DbService } from "./Db";
import { GitHubService } from "./GitHub";
import { SettingsService } from "./Settings";

/** Maximum rows returned to the homepage. Component renders 10 + a "N more" footer. */
const HOMEPAGE_PAGE_SIZE = 30;

/**
 * Sort comparator for the repo homepage feed: assigned-to-viewer rows pinned
 * to the top, then by `updatedAt DESC`. Matches the confirmed shape brief.
 */
function sortForHomepage(a: Issue, b: Issue): number {
  if (a.assignedToViewer !== b.assignedToViewer) return a.assignedToViewer ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export class IssuesService extends Context.Tag("IssuesService")<
  IssuesService,
  {
    /**
     * Fetch the latest open issues for a repo from GitHub, upsert them into
     * the local `github_issues` table, and return the top-N sorted feed for
     * the homepage. The fetched array is the truth source for this call;
     * the table is durable storage for phase 2 (in-app detail view + WS
     * reconciliation).
     *
     * `viewerLogin` is the caller's GitHub login — used to compute the
     * per-row `assignedToViewer` flag.
     */
    readonly listForRepo: (
      repoId: string,
      viewerLogin: string,
      accountId: string,
      accessToken: string,
    ) => Effect.Effect<
      ReadonlyArray<Issue>,
      GitHubError | NotFoundError | ValidationError,
      DbService | GitHubService | SettingsService
    >;
  }
>() {}

export const IssuesServiceLive = Layer.succeed(IssuesService, {
  listForRepo: (repoId, viewerLogin, accountId, accessToken) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const github = yield* GitHubService;

      // Resolve the repo + account-scoped ownership check before hitting GH.
      const repo = yield* Effect.try({
        try: () => db.select().from(repositories).where(eq(repositories.id, repoId)).get(),
        catch: (e) => new ValidationError({ message: String(e) }),
      });
      if (!repo || repo.accountId !== accountId) {
        return yield* Effect.fail(new NotFoundError({ resource: "repository", id: repoId }));
      }

      const fetched = yield* github.listOpenIssues(repo.fullName, repo.id, accessToken);

      // Upsert into the local table. Best-effort — a failed upsert doesn't
      // block the response; the next call refreshes anyway. Wrapped in
      // Effect.try per conventions §2.4 so a constraint/IO throw doesn't
      // escape as a defect.
      yield* Effect.try({
        try: () => {
          for (const raw of fetched) {
            db.insert(githubIssues)
              .values({
                id: raw.id,
                externalId: raw.externalId,
                nodeId: raw.nodeId,
                repositoryId: raw.repositoryId,
                title: raw.title,
                body: raw.body,
                state: raw.state,
                authorLogin: raw.authorLogin,
                authorAvatarUrl: raw.authorAvatarUrl,
                assigneeLogins: JSON.stringify(raw.assigneeLogins),
                labels: JSON.stringify(raw.labels),
                commentCount: raw.commentCount,
                url: raw.url,
                createdAt: raw.createdAt,
                updatedAt: raw.updatedAt,
                closedAt: raw.closedAt,
                fetchedAt: raw.fetchedAt,
              })
              .onConflictDoUpdate({
                target: githubIssues.id,
                set: {
                  title: raw.title,
                  body: raw.body,
                  state: raw.state,
                  authorLogin: raw.authorLogin,
                  authorAvatarUrl: raw.authorAvatarUrl,
                  assigneeLogins: JSON.stringify(raw.assigneeLogins),
                  labels: JSON.stringify(raw.labels),
                  commentCount: raw.commentCount,
                  updatedAt: raw.updatedAt,
                  closedAt: raw.closedAt,
                  fetchedAt: raw.fetchedAt,
                },
              })
              .run();
          }
        },
        catch: (e) => new ValidationError({ message: String(e) }),
      }).pipe(Effect.orElseSucceed(() => undefined));

      const issues: Issue[] = fetched.map((raw) => ({
        ...raw,
        assignedToViewer: raw.assigneeLogins.includes(viewerLogin),
      }));

      return issues.sort(sortForHomepage).slice(0, HOMEPAGE_PAGE_SIZE);
    }),
});
