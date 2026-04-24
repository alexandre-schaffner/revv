import { integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteTable, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { reviewSessions } from './review-sessions';
import { pullRequests } from './pull-requests';

/**
 * A generated AI walkthrough of a PR, pinned to a specific head SHA.
 *
 * Content is produced through a strict 4-phase pipeline (A→B→C→D) enforced at
 * the schema, MCP tool, and orchestrator level. See
 * "Agent Subsystem Invariants" in the root CLAUDE.md for the full doctrine.
 *
 * Immutability: a walkthrough is pinned to one `pr_head_sha`. A new commit on
 * the PR never mutates an existing row — the old row is marked `'superseded'`
 * with `superseded_by` pointing at the replacement, and a fresh row is
 * inserted. This preserves audit trail and guarantees clients see a
 * consistent view even mid-regeneration.
 */
export const walkthroughs = sqliteTable(
	'walkthroughs',
	{
		id: text('id').primaryKey(),
		reviewSessionId: text('review_session_id')
			.notNull()
			.references(() => reviewSessions.id, { onDelete: 'cascade' }),
		pullRequestId: text('pull_request_id')
			.notNull()
			.references(() => pullRequests.id, { onDelete: 'cascade' }),
		/**
		 * Phase A output: 2-3 sentence PR summary. Written by `set_overview` MCP
		 * tool. Defaults to empty string at row creation so the orchestrator can
		 * insert the row before Phase A runs — `lastCompletedPhase === 'none'`
		 * is the signal that summary isn't populated yet.
		 */
		summary: text('summary').notNull().default(''),
		/** Phase A output: `'low' | 'medium' | 'high'`. Written by `set_overview` MCP tool. */
		riskLevel: text('risk_level').notNull().default('low'),
		/**
		 * Phase C output: final "Overall Sentiment" paragraph. Nullable until
		 * Phase C completes. Written by `set_sentiment` MCP tool.
		 */
		sentiment: text('sentiment'),
		/**
		 * Job lifecycle status — owned exclusively by `WalkthroughJobs.setStatus`.
		 * Agents never write this field directly.
		 *   `generating` — job running or resumable
		 *   `complete`   — `complete_walkthrough` validation passed
		 *   `error`      — terminal failure (exceeded retries / unrecoverable)
		 *   `superseded` — a newer walkthrough (see `supersededBy`) replaced this
		 */
		status: text('status').notNull().default('generating'),
		/**
		 * Monotonically-advancing phase pointer — `'none' | 'A' | 'B' | 'C' | 'D'`.
		 * Advanced as a side effect of the MCP tool writes that complete each phase
		 * (transactionally, in the same `db.transaction` as the content write).
		 */
		lastCompletedPhase: text('last_completed_phase').notNull().default('none'),
		/**
		 * Self-FK set when `status='superseded'`: points at the walkthrough row
		 * that replaces this one (always same PR, newer head SHA).
		 */
		supersededBy: text('superseded_by').references(
			(): AnySQLiteColumn => walkthroughs.id,
			{ onDelete: 'set null' },
		),
		generatedAt: text('generated_at').notNull(),
		modelUsed: text('model_used').notNull(),
		tokenUsage: text('token_usage').notNull().default('{}'),
		prHeadSha: text('pr_head_sha').notNull(),
		opencodeSessionId: text('opencode_session_id'),
		// Incremented each time WalkthroughJobs.resumePending() picks this row back up
		// after a server restart. Capped at WALKTHROUGH_MAX_RESUME_ATTEMPTS before the
		// row is marked `error` and left alone.
		resumeAttempts: integer('resume_attempts').notNull().default(0),
	},
	(t) => ({
		/**
		 * Enforces the doctrine invariant "one walkthrough per (PR, head_sha)" at the
		 * database level. Makes `WalkthroughJobs.startJob` naturally idempotent:
		 * concurrent starts upsert onto the same row instead of spawning duplicates.
		 * Superseded rows share the PR but differ on head_sha, so this uniqueness
		 * doesn't block new-commit flows.
		 */
		prHeadShaUnique: uniqueIndex('walkthroughs_pr_head_sha_unique').on(
			t.pullRequestId,
			t.prHeadSha,
		),
	}),
);
