import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { AppRuntime } from '../runtime';
import { AiService } from '../services/Ai';
import { GitHubService } from '../services/GitHub';
import { getOrFetchDiffFiles } from '../services/DiffCache';
import { PullRequestService } from '../services/PullRequest';
import { RepositoryService } from '../services/Repository';
import { TokenProvider } from '../services/TokenProvider';
import { withAuth, mapErrorToSSEResponse, textStreamToSSE } from './middleware';

export const explainRoute = new Elysia()
	.use(withAuth)
	.get(
		'/api/explain',
		async (ctx) => {
			try {
				const textStream = await AppRuntime.runPromise(
					Effect.gen(function* () {
					const ai = yield* AiService;
					const prService = yield* PullRequestService;
					const repoService = yield* RepositoryService;
					const tokenProvider = yield* TokenProvider;
					const github = yield* GitHubService;

					// Resolve PR context
					const pr = yield* prService.getPr(ctx.query.prId);
					const repo = yield* repoService.getRepoById(pr.repositoryId);
					const ghToken = yield* tokenProvider.getGitHubToken(ctx.session.user.id);

					// Get file patches from the PR (cached)
					const files = yield* getOrFetchDiffFiles(
						pr.id,
						repo.fullName,
						pr.externalId,
						ghToken
					);
					const fileMeta = files.find((f) => f.path === ctx.query.filePath);
					const diff = fileMeta?.patch ?? '';

						// Get head SHA to fetch full file content
						const meta = yield* github.getPrMeta(
							repo.fullName,
							pr.externalId,
							ghToken
						);
						const fullFileContent = yield* github.getFileContent(
							repo.fullName,
							ctx.query.filePath,
							meta.headSha,
							ghToken
						);

						// Stream AI explanation
						return yield* ai.explainCode({
							filePath: ctx.query.filePath,
							lineRange: [Number(ctx.query.startLine), Number(ctx.query.endLine)],
							codeSnippet: ctx.query.codeSnippet ?? '',
							fullFileContent,
							prTitle: pr.title,
							prBody: pr.body,
							diff,
						});
					})
				);

				return new Response(textStreamToSSE(textStream), {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
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
		}
	);
