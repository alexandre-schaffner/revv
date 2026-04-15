import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { auth } from '../auth';
import { AppRuntime } from '../runtime';
import { AiService } from '../services/Ai';
import { GitHubService } from '../services/GitHub';
import { PullRequestService } from '../services/PullRequest';
import { RepositoryService } from '../services/Repository';
import { TokenProvider } from '../services/TokenProvider';

export const explainRoute = new Elysia().get(
	'/api/explain',
	async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			return new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Unauthorized' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		}

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
					const ghToken = yield* tokenProvider.getGitHubToken(session.user.id);

					// Get file patches from the PR
					const files = yield* github.getPrFiles(
						repo.fullName,
						pr.externalId,
						ghToken
					);
					const fileMeta = files.find((f) => f.filename === ctx.query.filePath);
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

			// Convert ReadableStream<string> to SSE format
			const encoder = new TextEncoder();
			const sseStream = new ReadableStream({
				async start(controller) {
					const reader = textStream.getReader();
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
							);
						}
						controller.enqueue(encoder.encode('data: [DONE]\n\n'));
						controller.close();
					} catch (err) {
						const errMsg = JSON.stringify({
							code: 'GENERATION_ERROR',
							message: err instanceof Error ? err.message : 'Unknown error',
						});
						controller.enqueue(
							encoder.encode(`event: error\ndata: ${errMsg}\n\n`)
						);
						controller.close();
					}
				},
			});

			return new Response(sseStream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
				},
			});
		} catch (e) {
			// Map tagged errors to HTTP responses
			if (e && typeof e === 'object' && '_tag' in e) {
				const tagged = e as { _tag: string };
				if (tagged._tag === 'AiNotConfiguredError') {
					return new Response(
						JSON.stringify({
							code: 'NOT_CONFIGURED',
							message: 'AI API key not configured',
						}),
						{ status: 400, headers: { 'Content-Type': 'application/json' } }
					);
				}
				if (tagged._tag === 'AiAuthError') {
					return new Response(
						JSON.stringify({
							code: 'AI_AUTH_ERROR',
							message: 'Invalid API key',
						}),
						{ status: 401, headers: { 'Content-Type': 'application/json' } }
					);
				}
				if (tagged._tag === 'AiRateLimitError') {
					const retryAfter = (e as unknown as { retryAfter: number }).retryAfter;
					return new Response(
						JSON.stringify({
							code: 'RATE_LIMITED',
							message: `Rate limited — retry in ${retryAfter}s`,
							retryAfter,
						}),
						{ status: 429, headers: { 'Content-Type': 'application/json' } }
					);
				}
				if (tagged._tag === 'NotFoundError') {
					return new Response(
						JSON.stringify({ code: 'NOT_FOUND', message: 'PR not found' }),
						{ status: 404, headers: { 'Content-Type': 'application/json' } }
					);
				}
			}
			return new Response(
				JSON.stringify({
					code: 'INTERNAL_ERROR',
					message: 'Failed to generate explanation',
				}),
				{ status: 500, headers: { 'Content-Type': 'application/json' } }
			);
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
