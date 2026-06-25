// ── ChatMcpTokens ──────────────────────────────────────────────────────────
//
// In-memory bearer-token registry that lets the opencode chat agent reach
// the chat MCP endpoint with PR-scoped authority + caller identity (for
// walkthrough-edit tools that stamp lastEditedBy / userId on the edited
// row).
//
//   Lifecycle: chat-opencode.ts mints a token via `issue({ prId, userId,
//   actor, interactionMode })` before registering the MCP server with the
//   daemon, sends the token in the `Authorization: Bearer …` header on the
//   registration, and revokes it via `clear(token)` once the chat turn
//   finishes.
//
// Mirrors the WalkthroughJobs.issueSessionToken / resolveSessionToken
// pattern (in-process, ephemeral — doctrine invariant #1: nothing here is
// durable). Tokens are crypto-random UUIDs; we do not hash them because
// the registry only lives in this process's memory.

import type { InteractionMode } from "@revv/shared";
import { Context, Effect, Layer, Ref } from "effect";

/**
 * Source transport that minted this token. Stamped on
 * `walkthroughs.lastEditedBy` when an edit MCP tool fires through this
 * registry's HTTP path. All chat edits run on the ACP transport, so the
 * only actor today is `'chat:acp'`.
 */
export type ChatTokenActor = "chat:acp";

export interface ChatTokenIssueArgs {
  readonly prId: string;
  readonly userId: string;
  readonly actor: ChatTokenActor;
  readonly interactionMode: InteractionMode;
}

export interface ChatTokenResolved {
  readonly prId: string;
  readonly userId: string;
  readonly actor: ChatTokenActor;
  readonly interactionMode: InteractionMode;
}

interface TokenEntry extends ChatTokenResolved {
  readonly issuedAt: number;
}

export class ChatMcpTokens extends Context.Tag("ChatMcpTokens")<
  ChatMcpTokens,
  {
    /** Mint a fresh token bound to the supplied identity. Returns the bearer token. */
    readonly issue: (args: ChatTokenIssueArgs) => Effect.Effect<string>;
    /** Resolve a token back to its bound identity, or null if unknown / revoked. */
    readonly resolve: (token: string) => Effect.Effect<ChatTokenResolved | null>;
    /** Revoke a token (best-effort — silent if already gone). */
    readonly clear: (token: string) => Effect.Effect<void>;
  }
>() {}

export const ChatMcpTokensLive = Layer.effect(
  ChatMcpTokens,
  Effect.gen(function* () {
    const ref = yield* Ref.make(new Map<string, TokenEntry>());

    return {
      issue: (args) =>
        Effect.gen(function* () {
          const token = crypto.randomUUID();
          yield* Ref.update(ref, (m) => {
            const next = new Map(m);
            next.set(token, {
              prId: args.prId,
              userId: args.userId,
              actor: args.actor,
              interactionMode: args.interactionMode,
              issuedAt: Date.now(),
            });
            return next;
          });
          return token;
        }),

      resolve: (token) =>
        Effect.gen(function* () {
          const m = yield* Ref.get(ref);
          const entry = m.get(token);
          if (!entry) return null;
          return {
            prId: entry.prId,
            userId: entry.userId,
            actor: entry.actor,
            interactionMode: entry.interactionMode,
          };
        }),

      clear: (token) =>
        Ref.update(ref, (m) => {
          if (!m.has(token)) return m;
          const next = new Map(m);
          next.delete(token);
          return next;
        }),
    };
  }),
);
