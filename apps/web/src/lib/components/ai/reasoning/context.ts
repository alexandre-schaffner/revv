export interface ReasoningContext {
	readonly isStreaming: boolean;
	readonly isOpen: boolean;
	readonly duration: number | undefined;
}

export const REASONING_CTX_KEY = Symbol("ai-reasoning");
