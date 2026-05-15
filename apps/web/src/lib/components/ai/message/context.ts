export type MessageRole = "user" | "assistant" | "system";

export interface MessageContext {
	readonly role: MessageRole;
}

export const MESSAGE_CTX_KEY = Symbol("ai-message");
