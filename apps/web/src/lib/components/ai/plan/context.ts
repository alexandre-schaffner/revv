export interface PlanContext {
	readonly isStreaming: boolean;
}

export const PLAN_CTX_KEY = Symbol("ai-plan");
