import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';
import { db } from '../auth';
import { user } from '../db/schema';
import { withAuth, handleAppError } from './middleware';

/**
 * Onboarding gate endpoint.
 *
 * The frontend's `OnboardingGate` shows the multi-step welcome flow whenever
 * the authenticated user has no `onboardedAt` timestamp. The `complete`
 * action sets it to the current time and returns the updated value so the
 * gate can flip into the app shell without waiting for a session refetch.
 *
 * Idempotent: re-calling on an already-onboarded user is a no-op (returns
 * the existing timestamp). Onboarding never "un-completes" — to re-run the
 * flow during development, clear the column directly in SQLite.
 */
export const onboardingRoutes = new Elysia({ prefix: '/api/onboarding' })
	.use(withAuth)
	.post('/complete', async (ctx) => {
		try {
			const userId = ctx.session.user.id;
			const now = new Date();

			const existing = await db
				.select({ onboardedAt: user.onboardedAt })
				.from(user)
				.where(eq(user.id, userId));
			const current = existing[0]?.onboardedAt ?? null;

			if (current) {
				return { onboardedAt: current.toISOString() };
			}

			await db
				.update(user)
				.set({ onboardedAt: now, updatedAt: now })
				.where(eq(user.id, userId));

			return { onboardedAt: now.toISOString() };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})
	/**
	 * Clear the user's `onboardedAt` so the gate re-shows the flow on next
	 * render. Used by the "Replay onboarding" affordance in settings —
	 * auth and tracked repos are intentionally untouched. The frontend
	 * pairs this with a sessionStorage flag that forces the flow to start
	 * from the welcome step rather than honoring its usual resume logic.
	 */
	.post('/reset', async (ctx) => {
		try {
			const userId = ctx.session.user.id;
			await db
				.update(user)
				.set({ onboardedAt: null, updatedAt: new Date() })
				.where(eq(user.id, userId));
			return { onboardedAt: null };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	});
