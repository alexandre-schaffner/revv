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

				// Read current stored login + image (server-refreshed avatar URL).
				const rows = await db
					.select({ githubLogin: user.githubLogin, image: user.image })
					.from(user)
					.where(eq(user.id, userId));
				let login: string | null = rows[0]?.githubLogin ?? null;
				let avatarUrl: string | null = rows[0]?.image ?? null;

				// Backfill if missing — best-effort, don't fail the endpoint.
				// Also lazily refresh the avatar URL here so callers loading the
				// app get a fresh signed URL even if the poll scheduler hasn't
				// run yet this session.
				if (!login || !avatarUrl) {
					const backfilled = await AppRuntime.runPromise(
						Effect.gen(function* () {
							const tokenProvider = yield* TokenProvider;
							const github = yield* GitHubService;
							const token = yield* tokenProvider.getGitHubToken(userId);
							const gh = yield* github.getAuthenticatedUserFresh(token);
							return gh;
						}).pipe(Effect.orElseSucceed(() => null)),
					);
					if (backfilled) {
						const updates: { githubLogin?: string; image?: string | null; updatedAt: Date } = {
							updatedAt: new Date(),
						};
						if (!login) updates.githubLogin = backfilled.login;
						if (!avatarUrl) updates.image = backfilled.avatarUrl;
						await db.update(user).set(updates).where(eq(user.id, userId));
						login = login ?? backfilled.login;
						avatarUrl = avatarUrl ?? backfilled.avatarUrl;
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

				const identity: UserIdentity = { login, role, avatarUrl };
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
