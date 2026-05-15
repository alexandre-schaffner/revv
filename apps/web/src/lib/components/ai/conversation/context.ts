export interface ConversationContext {
	readonly scrollToBottom: () => void;
	readonly isAtBottom: boolean;
}

export const CONVERSATION_CTX_KEY = Symbol("ai-conversation");
