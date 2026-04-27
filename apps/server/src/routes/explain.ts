import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { AiService } from "../services/Ai";
import { getOrFetchDiffFiles } from "../services/DiffCache";
import { FileContentService } from "../services/FileContent";
import { GitHubService } from "../services/GitHub";
import { PrContextService } from "../services/PrContext";
import { mapErrorToSSEResponse, textStreamToSSE, withAuth } from "./middleware";

export const explainRoute = new Elysia().use(withAuth).get(
  "/api/explain",
  async (ctx) => {
    try {
      const textStream = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const ai = yield* AiService;
          const prCtx = yield* PrContextService;
          const fileContent = yield* FileContentService;

          // Single call resolves PR + repo + GitHub token
          const { pr, repo, token } = yield* prCtx.resolveBasic(
            ctx.query.prId,
            ctx.session.user.id,
          );

          // Cached PR diff files
          const files = yield* getOrFetchDiffFiles(
            pr.id,
            repo.fullName,
            pr.externalId,
            token,
          );
          const fileMeta = files.find((f) => f.path === ctx.query.filePath);
          const diff = fileMeta?.patch ?? "";

          // Use headSha from the DB row — no extra GitHub round-trip.
          // Fall back to a fresh getPrMeta only in the rare case the
          // cached row is missing one (shouldn't happen for open PRs
          // that PollScheduler has touched).
          let headSha = pr.headSha;
          if (!headSha) {
            const github = yield* GitHubService;
            const meta = yield* github.getPrMeta(
              repo.fullName,
              pr.externalId,
              token,
            );
            headSha = meta.headSha;
          }

          // Immutable-by-ref file content cache — second call for the
          // same (repo, path, sha) returns directly from SQLite.
          const fullFileContent = yield* fileContent.getOrFetch(
            repo.fullName,
            ctx.query.filePath,
            headSha,
            token,
          );

          return yield* ai.explainCode({
            filePath: ctx.query.filePath,
            lineRange: [Number(ctx.query.startLine), Number(ctx.query.endLine)],
            codeSnippet: ctx.query.codeSnippet ?? "",
            fullFileContent,
            prTitle: pr.title,
            prBody: pr.body,
            diff,
          });
        }),
      );

      return new Response(textStreamToSSE(textStream), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } catch (e) {
      return mapErrorToSSEResponse(e);
    }
  },
  {
    query: t.Object({
      prId: t.String(),
      filePath: t.String(),
      startLine: t.String(),
      endLine: t.String(),
      codeSnippet: t.Optional(t.String()),
    }),
  },
);
