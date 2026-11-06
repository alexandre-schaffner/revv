// Bearer tokens for `/mcp/chat-context`: each chat turn's agent reaches the
// chat tools with the PR, the user and the interaction mode its token was
// issued for. Ephemeral (invariant #1): a restart wipes them, and the next
// turn issues a new one.

import type { InteractionMode } from "@revv/shared";
import { Context, Layer } from "effect";
import { CHAT_TURN } from "../ai/acp/run-turn";
import { makeSessionTokenStore, type SessionTokenStore } from "./session-token-store";

export interface ChatTokenResolved {
  readonly prId: string;
  readonly userId: string;
  readonly interactionMode: InteractionMode;
}

/** The turn ceiling plus slack: a token can't expire mid-turn, nor outlive a missed clear by much. */
const CHAT_TOKEN_TTL_MS = CHAT_TURN.ceilingMs + 5 * 60_000;

export class ChatMcpTokens extends Context.Service<
  ChatMcpTokens,
  SessionTokenStore<ChatTokenResolved>
>()("ChatMcpTokens") {}

export const ChatMcpTokensLive = Layer.effect(
  ChatMcpTokens,
  makeSessionTokenStore<ChatTokenResolved>(CHAT_TOKEN_TTL_MS),
);
