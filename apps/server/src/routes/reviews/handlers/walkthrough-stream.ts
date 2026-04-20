import { Effect } from 'effect';
import { AppRuntime } from '../../../runtime';
import { debug, logError } from '../../../logger';
import { GitHubService } from '../../../services/GitHub';
import { PrContextService } from '../../../services/PrContext';
import { WalkthroughJobs } from '../../../services/WalkthroughJobs';
import { WalkthroughService } from '../../../services/Walkthrough';
import { unwrapEffectError } from '../../middleware';
import { createSseStream, sseHeaders } from '../sse';
import type { WalkthroughStreamEvent } from '@revv/shared';

/**
 * GET /api/reviews/:id/walkthrough — SSE streaming walkthrough.
 *
 * Thin subscriber around {@link WalkthroughJobs}. The durable generation
 * fiber lives in the service; this handler just:
 *   1. Resolves PR + headSha (lightweight — no diff).
 *   2. Serves a fully-cached walkthrough inline if one exists for that sha.
 *   3. Finds or starts the active job for the PR.
 *   4. Subscribes (in buffering mode) to the job's live event stream.
 *   5. Replays the DB snapshot through the same dedupe-aware forwarder.
 *   6. Flushes the subscriber's buffer — any events that arrived during
 *      the DB read now drain in order, then future events forward directly.
 *   7. Stays open until `done` / `error` closes the writer, or the client
 *      disconnects (in which case we unsubscribe but the job keeps running
 *      in the background — that's the durability story).
 *
 * Dedupe is needed because the replay+live handoff window can deliver a
 * single event from both sides: the live fanout captures it as the fiber
 * persists it, and the DB snapshot we read a moment later also returns
 * it. Seen-sets keyed by block.id / issue.id / rating.axis / summary-once
 * collapse the duplicates without dropping events that legitimately only
 * came from one path.
 */
export function walkthroughStreamHandler(ctx: {
	params: { id: string };
	session: { user: { id: string } };
}): Response {
	const { stream, writer, stopHeartbeat, onCancel } = createSseStream();

	// Cleanup: always stop the heartbeat once the client goes away or we
	// terminate the stream — the writer/stream handles both cases through
	// onCancel(), so one registration covers everything.
	onCancel(() => stopHeartbeat());

	void (async () => {
		// Dedupe state for the subscribe-then-replay handoff.
		let seenSummary = false;
		const seenBlocks = new Set<string>();
		const seenIssues = new Set<string>();
		const seenRatingAxes = new Set<string>();
		let terminated = false;

		const forwardEvent = (event: WalkthroughStreamEvent): void => {
			if (terminated) return;

			switch (event.type) {
				case 'summary':
					if (seenSummary) return;
					seenSummary = true;
					break;
				case 'block':
					if (seenBlocks.has(event.data.id)) return;
					seenBlocks.add(event.data.id);
					break;
				case 'issue':
					if (seenIssues.has(event.data.id)) return;
					seenIssues.add(event.data.id);
					break;
				case 'rating':
					if (seenRatingAxes.has(event.data.axis)) return;
					seenRatingAxes.add(event.data.axis);
					break;
				default:
					break;
			}

			writer.send(event);

			if (event.type === 'done') {
				terminated = true;
				writer.sendDone();
			} else if (event.type === 'error') {
				terminated = true;
				writer.close();
			}
		};

		try {
			// Send the first phase synchronously so the client UI unblocks
			// immediately while we do the setup dance below.
			if (!writer.sendPhase('connecting', 'Connecting...')) return;

			// ── Step 1: Resolve PR basics + headSha (no diff fetch) ──────
			// Diff fetch happens inside WalkthroughJobs.startJob, so if we
			// short-circuit on cache we never paid for it.
			if (!writer.sendPhase('connecting', 'Fetching PR details...')) return;

			const resolved = await AppRuntime.runPromise(
				Effect.gen(function* () {
					const prContext = yield* PrContextService;
					const github = yield* GitHubService;
					const basic = yield* prContext.resolveBasic(ctx.params.id, ctx.session.user.id);
					const meta = yield* github.getPrMeta(
						basic.repo.fullName,
						basic.pr.externalId,
						basic.token,
					);
					return { prId: basic.pr.id, headSha: meta.headSha };
				}),
			);

			// ── Step 2: Cache hit? Replay inline and terminate. ──────────
			const cached = await AppRuntime.runPromise(
				Effect.flatMap(WalkthroughService, (s) =>
					s.getCached(resolved.prId, resolved.headSha),
				),
			);
			if (cached) {
				forwardEvent({ type: 'summary', data: { summary: cached.summary, riskLevel: cached.riskLevel } });
				for (const block of cached.blocks) forwardEvent({ type: 'block', data: block });
				for (const issue of cached.issues) forwardEvent({ type: 'issue', data: issue });
				for (const rating of cached.ratings) forwardEvent({ type: 'rating', data: rating });
				forwardEvent({
					type: 'done',
					data: { walkthroughId: cached.id, tokenUsage: cached.tokenUsage },
				});
				return;
			}

			// ── Step 3: Find the live job, or start one. ─────────────────
			if (!writer.sendPhase('connecting', 'Starting AI analysis...')) return;

			const { walkthroughId } = await AppRuntime.runPromise(
				Effect.gen(function* () {
					const jobs = yield* WalkthroughJobs;
					const existing = yield* jobs.findActiveByPr(resolved.prId);
					if (existing !== null && existing.prHeadSha === resolved.headSha) {
						return { walkthroughId: existing.walkthroughId };
					}
					return yield* jobs.startJob({
						prId: resolved.prId,
						userId: ctx.session.user.id,
						trigger: 'user',
					});
				}),
			);

			// ── Step 4: Subscribe in buffering mode BEFORE the DB read. ──
			// The buffer captures events arriving during steps 4–6 so we
			// can replay them in order after the snapshot, and THEN switch
			// to direct-forward mode.
			const sub = await AppRuntime.runPromise(
				Effect.flatMap(WalkthroughJobs, (jobs) =>
					jobs.subscribe(walkthroughId, forwardEvent),
				),
			);

			if (!sub.found) {
				// Job finished between startJob and subscribe (e.g. tiny
				// cached repos complete in milliseconds). Read the final
				// state from the DB and replay as a terminal sequence.
				const finalState = await AppRuntime.runPromise(
					Effect.flatMap(WalkthroughService, (s) =>
						s.getCached(resolved.prId, resolved.headSha),
					),
				);
				if (finalState) {
					forwardEvent({
						type: 'summary',
						data: { summary: finalState.summary, riskLevel: finalState.riskLevel },
					});
					for (const block of finalState.blocks) forwardEvent({ type: 'block', data: block });
					for (const issue of finalState.issues) forwardEvent({ type: 'issue', data: issue });
					for (const rating of finalState.ratings) forwardEvent({ type: 'rating', data: rating });
					forwardEvent({
						type: 'done',
						data: { walkthroughId: finalState.id, tokenUsage: finalState.tokenUsage },
					});
					return;
				}
				// No cached row either — the job must have errored. Fall
				// back to the partial (which may now be marked error).
				const partial = await AppRuntime.runPromise(
					Effect.flatMap(WalkthroughService, (s) =>
						s.getPartial(resolved.prId, resolved.headSha),
					),
				);
				if (partial) {
					forwardEvent({
						type: 'summary',
						data: { summary: partial.summary, riskLevel: partial.riskLevel },
					});
					for (const block of partial.blocks) forwardEvent({ type: 'block', data: block });
					for (const issue of partial.issues) forwardEvent({ type: 'issue', data: issue });
					for (const rating of partial.ratings) forwardEvent({ type: 'rating', data: rating });
					forwardEvent({
						type: 'error',
						data: { code: 'AiGenerationError', message: 'Walkthrough generation failed' },
					});
					return;
				}
				// Nothing to replay — surface a generic error so the UI
				// doesn't hang on the phase message.
				forwardEvent({
					type: 'error',
					data: {
						code: 'NotFound',
						message: 'Walkthrough job ended before we could subscribe',
					},
				});
				return;
			}

			// Auto-unsubscribe on client disconnect so the job's subscriber
			// set doesn't accumulate dead handles across re-connects.
			onCancel(sub.unsubscribe);

			// ── Step 5: Replay the DB snapshot through forwardEvent ──────
			// This also passes through the dedupe so events captured by
			// the buffered subscriber (between subscribe and snapshot)
			// don't get sent twice.
			const snapshot = await AppRuntime.runPromise(
				Effect.flatMap(WalkthroughService, (s) =>
					s.getPartial(resolved.prId, resolved.headSha),
				),
			);
			if (snapshot) {
				forwardEvent({
					type: 'summary',
					data: { summary: snapshot.summary, riskLevel: snapshot.riskLevel },
				});
				for (const block of snapshot.blocks) forwardEvent({ type: 'block', data: block });
				for (const issue of snapshot.issues) forwardEvent({ type: 'issue', data: issue });
				for (const rating of snapshot.ratings) forwardEvent({ type: 'rating', data: rating });
			}

			// ── Step 6: Drain the buffer, switch to direct-forward mode. ─
			// After this call, forwardEvent runs synchronously as events
			// arrive from the job's fanout. The stream stays open until
			// the fanout delivers `done` / `error`, or the client
			// disconnects.
			sub.flush();
			debug('walkthrough-sse', 'subscribed + replayed — waiting for live events');
		} catch (err) {
			logError('walkthrough-sse', 'handler error:', err);
			const e = unwrapEffectError(err);
			// Check for clone-in-progress — send special code with repoId so
			// the UI can show a progress bar and auto-retry when ready.
			if (e != null && typeof e === 'object' && '_tag' in e && (e as { _tag: string })._tag === 'CloneInProgressError') {
				const cloneErr = e as unknown as { repoId: string };
				forwardEvent({
					type: 'error',
					data: { code: 'CloneInProgress', message: 'Repository is being cloned', repoId: cloneErr.repoId },
				});
			} else {
				const message = e instanceof Error ? e.message : 'Walkthrough connection failed';
				forwardEvent({
					type: 'error',
					data: { code: 'SetupError', message },
				});
			}
		}
	})();

	return new Response(stream, { headers: sseHeaders });
}
