import { Elysia, t } from 'elysia';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { db } from '../auth';
import { user } from '../db/schema';
import { AppRuntime } from '../runtime';
import { PullRequestService } from '../services/PullRequest';
import { GitHubService } from '../services/GitHub';
import { TokenProvider } from '../services/TokenProvider';
import { withAuth, handleAppError } from './middleware';
import type { UserIdentity, UserRole } from '@revv/shared';

/**
 * Return the current user's GitHub identity and (optionally) their role for a PR.
 *
 * Role is `coder` when the user's GitHub login matches the PR author, otherwise
 * `reviewer`. Without a `prId` we return `unknown` — the frontend only needs role
 * info when rendering PR-scoped UI.
 *
 * If the stored `githubLogin` is missing (e.g. account predates the field), we
 * lazily backfill it from GitHub on first call.
 */
export const userRoutes = new Elysia({ prefix: '/api/user' })
	.use(withAuth)
	.get(
		'/identity',
		async (ctx) => {
			try {
				const userId = ctx.session.user.id;

				// Read current stored login
				const rows = await db
					.select({ githubLogin: user.githubLogin })
					.from(user)
					.where(eq(user.id, userId));
				let login: string | null = rows[0]?.githubLogin ?? null;

				// Backfill if missing — best-effort, don't fail the endpoint.
				if (!login) {
					const backfilled = await AppRuntime.runPromise(
						Effect.gen(function* () {
							const tokenProvider = yield* TokenProvider;
							const github = yield* GitHubService;
							const token = yield* tokenProvider.getGitHubToken(userId);
							const gh = yield* github.getAuthenticatedUser(token);
							return gh.login;
						}).pipe(Effect.orElseSucceed(() => null)),
					);
					if (backfilled) {
						await db
							.update(user)
							.set({ githubLogin: backfilled, updatedAt: new Date() })
							.where(eq(user.id, userId));
						login = backfilled;
					}
				}

				// Compute role if a PR is supplied
				let role: UserRole = 'unknown';
				const prId = ctx.query.prId;
				if (prId && login) {
					const pr = await AppRuntime.runPromise(
						Effect.flatMap(PullRequestService, (s) => s.getPr(prId)).pipe(
							Effect.orElseSucceed(() => null),
						),
					);
					if (pr) role = pr.authorLogin === login ? 'coder' : 'reviewer';
				}

				const identity: UserIdentity = { login, role };
				return identity;
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{
			query: t.Object({
				prId: t.Optional(t.String()),
			}),
		},
	);
