import { Effect } from 'effect';
import { AppRuntime } from '../../../runtime';
import { GitHubService } from '../../../services/GitHub';
import { PrContextService } from '../../../services/PrContext';
import { ReviewService } from '../../../services/Review';
import { WalkthroughService } from '../../../services/Walkthrough';

export interface SubmitReviewCommentInput {
	path: string;
	body: string;
	line: number;
	side: 'LEFT' | 'RIGHT';
	startLine?: number;
	threadId: string;
}

export interface SubmitReviewInput {
	action: 'approve' | 'request_changes' | 'comment';
	body?: string;
	comments?: SubmitReviewCommentInput[];
	/**
	 * Walkthrough issue ids included in this submission. Persisted onto the
	 * issue rows so the UI's "already posted" state survives reloads and
	 * PR-switches. Empty / missing for pure approve flows with no issue list.
	 */
	issueIds?: string[];
}

/**
 * POST /api/reviews/:id/github-submit — submit a review to GitHub with
 * line-level comments. Maps our internal action type to GitHub's `event`
 * enum and builds the multi-line comment payloads the REST API expects.
 *
 * After posting, we fetch the created review comments from GitHub and link
 * them back to the corresponding local threads/messages via their external IDs.
 * This prevents pullComments (called by sync-threads immediately after) from
 * treating our own comments as new and creating duplicate threads.
 */
export function submitGithubReviewHandler(
	prId: string,
	userId: string,
	body: SubmitReviewInput,
) {
	return AppRuntime.runPromise(
		Effect.gen(function* () {
			const prContext = yield* PrContextService;
			const github = yield* GitHubService;
			const reviewService = yield* ReviewService;
			const walkthroughService = yield* WalkthroughService;

			const { pr, repo, token: ghToken } = yield* prContext.resolveBasic(prId, userId);

			const eventMap = {
				approve: 'APPROVE',
				request_changes: 'REQUEST_CHANGES',
				comment: 'COMMENT',
			} as const;

			const comments = (body.comments ?? []).map((c) => {
				const comment: {
					path: string;
					body: string;
					line: number;
					side: 'LEFT' | 'RIGHT';
					startLine?: number;
					startSide?: 'LEFT' | 'RIGHT';
				} = {
					path: c.path,
					body: c.body,
					line: c.line,
					side: c.side,
				};
				if (c.startLine !== undefined && c.startLine !== c.line) {
					comment.startLine = c.startLine;
					comment.startSide = c.side;
				}
				return comment;
			});

			const review = yield* github.postReview(
				repo.fullName,
				pr.externalId,
				{
					event: eventMap[body.action],
					body: body.body ?? '',
					comments,
				},
				ghToken,
			);

			// Link local threads to GitHub comment IDs so that the subsequent
			// sync-threads call doesn't create duplicate entries.
			const inputComments = body.comments ?? [];
			if (inputComments.length > 0) {
				const ghComments = yield* github.listReviewCommentsForReview(
					repo.fullName,
					pr.externalId,
					review.id,
					ghToken,
				).pipe(Effect.orElseSucceed(() => []));

				for (const input of inputComments) {
					const effectiveLine = input.line;
					const match = ghComments.find((gh) => {
						const ghLine = gh.line ?? gh.originalLine;
						return gh.path === input.path && ghLine === effectiveLine && gh.body === input.body;
					});

					if (!match) {
						console.warn(
							`[github-submit] No GitHub comment matched for thread ${input.threadId} (path=${input.path} line=${effectiveLine})`,
						);
						continue;
					}

					// Set external ID on the thread row
					yield* reviewService.setThreadExternalIds(input.threadId, {
						externalCommentId: String(match.id),
					}).pipe(Effect.orElseSucceed(() => undefined));

					// Find the last unsynced reviewer message in this thread and link it
					const messages = yield* reviewService.getMessages(input.threadId)
						.pipe(Effect.orElseSucceed(() => []));
					const unsyncedMsg = [...messages]
						.reverse()
						.find((m) => m.authorRole === 'reviewer' && m.externalId == null);
					if (unsyncedMsg) {
						yield* reviewService.setMessageExternalId(unsyncedMsg.id, String(match.id))
							.pipe(Effect.orElseSucceed(() => undefined));
					}
				}
			}

			// Persist which walkthrough issues the reviewer just sent so the
			// "already posted" treatment (grayed-out, unselectable) survives
			// reloads and PR-switches. Stamped regardless of action — an
			// approve that happens to include walkthrough issues in the body
			// also counts as "sent to GitHub."
			const issueIds = body.issueIds ?? [];
			const issuesSubmittedAt =
				issueIds.length > 0
					? yield* walkthroughService.markIssuesSubmitted(issueIds)
					: null;

			return {
				id: review.id,
				htmlUrl: review.htmlUrl,
				issuesSubmittedAt,
				submittedIssueIds: issueIds,
			};
		}),
	);
}
