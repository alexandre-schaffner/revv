import type { MessageRole } from "@revv/shared";

export type { MessageRole };

export interface MessageContext {
  readonly role: MessageRole;
}

export const MESSAGE_CTX_KEY = Symbol("ai-message");
