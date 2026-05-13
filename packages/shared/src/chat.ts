// ── Chat types ───────────────────────────────────────────────────────────────
//
// Shared types for the right-pane chat's three structured surfaces:
// task lists (TodoWrite / opencode todos), plans (ExitPlanMode / plan agent),
// and sub-agent invocations (Task tool / opencode AgentPart).
//
// These shapes are the wire-level contract between the Elysia server and the
// SvelteKit frontend, and the persistence shape in `chat_tasks`,
// `chat_plans`, and `chat_subagent_invocations` mirrors them 1:1.

/**
 * Session-level interaction toggle. Borrows the t3code naming so semantics
 * are easy to look up. `plan` flips the underlying driver into plan-mode for
 * every turn in the session until either the user toggles back to `default`
 * or a plan-approval flow auto-flips.
 */
export type InteractionMode = 'default' | 'plan';

/**
 * One row from the agent's running todo list. Snapshot semantics: providers
 * emit the full list each update; the server upserts in place keyed on
 * `taskId` so the client can re-render diff-free.
 */
export interface ChatTask {
	readonly id: string;
	readonly content: string;
	readonly activeForm: string | null;
	readonly status: 'pending' | 'in_progress' | 'completed';
	readonly priority: 'low' | 'medium' | 'high' | null;
}

/**
 * A plan emitted by the agent in plan mode. Status reflects user decision
 * — plans never auto-transition.
 */
export interface ChatPlan {
	readonly id: string;
	readonly turnId: string;
	readonly planMarkdown: string;
	readonly status: 'pending' | 'approved' | 'rejected' | 'superseded';
	readonly source: 'claude' | 'opencode';
	readonly createdAt: string;
	readonly decidedAt: string | null;
}

/**
 * One sub-agent invocation. The UI renders this as a collapsible card; all
 * `Activity` rows whose `subagentInvocationId === id` get grouped under it.
 */
export interface ChatSubagentInvocation {
	readonly id: string;
	readonly parentTurnId: string;
	readonly subagentType: string;
	readonly description: string;
	readonly prompt: string;
	readonly status: 'running' | 'completed' | 'errored';
	readonly result: string | null;
	readonly source: 'claude' | 'opencode';
	readonly startedAt: string;
	readonly completedAt: string | null;
}
