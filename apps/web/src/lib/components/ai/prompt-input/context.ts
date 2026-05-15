export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export interface PromptInputMessage {
	text: string;
	files?: File[];
}

export interface PromptInputContext {
	readonly status: PromptInputStatus;
	readonly value: string;
	setValue: (v: string) => void;
	readonly submit: () => void;
	readonly stop: () => void;
}

export const PROMPT_INPUT_CTX_KEY = Symbol("ai-prompt-input");
