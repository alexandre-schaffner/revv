import type { Snippet } from "svelte";

export type MessageRole = "user" | "assistant" | "system";

export interface MessageContext {
	readonly role: MessageRole;
}

export const MESSAGE_CTX_KEY = Symbol("ai-message");
