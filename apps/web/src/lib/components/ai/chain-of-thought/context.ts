export type ChainOfThoughtStepStatus = "complete" | "active" | "pending";

export interface ChainOfThoughtContext {
	readonly isOpen: boolean;
}

export const COT_CTX_KEY = Symbol("ai-chain-of-thought");
